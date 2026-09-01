package api

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/chat"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

const (
	sessionHistoryDefaultLimit     = 5
	sessionHistoryMaxLimit         = 5
	sessionHistoryMaxJSONLLine     = 1 << 20 // 1 MiB; metadata records are normally only a few KiB.
	sessionHistorySourceStored     = "stored"
	sessionHistorySourceDiscovered = "discovered"
	// Bounds for the dangling-recovery branch scan: at most this many session
	// files are opened, and at most this many candidates are returned.
	sessionBranchScanMaxFiles      = 32
	sessionBranchScanMaxCandidates = 8
)

type sessionHistoryItem struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Source         string `json:"source"`
	RecencyMs      int64  `json:"recencyMs"`
	ResumeIdentity string `json:"resumeIdentity,omitempty"`
	// Dangling flags a stored row whose piSessionId is an absolute path whose
	// session file is gone. Discovered rows never set it.
	Dangling bool `json:"dangling,omitempty"`
}

type sessionHistoryPage struct {
	Items      []sessionHistoryItem `json:"items"`
	NextCursor string               `json:"nextCursor"`
}

type diskSession struct {
	ID        string
	Name      string
	Path      string
	RecencyMs int64
}

type sessionHistoryCursor struct {
	RecencyMs int64  `json:"r"`
	ID        string `json:"i"`
}

func codingAgentDir() string {
	if v := os.Getenv("OMO_CODING_AGENT_DIR"); v != "" {
		return v
	}
	if v := os.Getenv("SENPI_CODING_AGENT_DIR"); v != "" {
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".omo", "agent")
}

// sessionDirNameForCwd encodes an absolute working directory the way omo
// names per-cwd folders under <agentDir>/sessions/: strip surrounding slashes,
// replace every remaining "/" with "-", then wrap with "--" on both ends.
// Example: /Volumes/storage/workspace/omo-webchat becomes
// --Volumes-storage-workspace-omo-webchat--.
func sessionDirNameForCwd(cwd string) string {
	trimmed := strings.Trim(filepath.Clean(cwd), "/")
	return "--" + strings.ReplaceAll(trimmed, "/", "-") + "--"
}

func listDiskSessions(cwd string) []diskSession {
	agentDir := codingAgentDir()
	if agentDir == "" || cwd == "" {
		return nil
	}
	dir := filepath.Join(agentDir, "sessions", sessionDirNameForCwd(cwd))
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	out := make([]diskSession, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}
		sess, ok := parseSessionFile(filepath.Join(dir, entry.Name()))
		if !ok {
			continue
		}
		out = append(out, sess)
	}
	return out
}

// resolveDiskSessionPath accepts only an exact path or session ID returned by
// the disk-session lister for cwd. It returns the lister's path so the provider
// always receives a workspace-owned sessionPath, even when the client used an ID.
func resolveDiskSessionPath(cwd, identity string) (string, bool) {
	for _, sess := range listDiskSessions(cwd) {
		if identity == sess.Path || identity == sess.ID {
			return sess.Path, true
		}
	}
	return "", false
}

func parseSessionFile(path string) (diskSession, bool) {
	f, err := os.Open(path)
	if err != nil {
		return diskSession{}, false
	}
	defer f.Close()

	headerLine, tooLong, _ := readJSONLLine(bufio.NewReader(f))
	if tooLong || len(headerLine) == 0 {
		return diskSession{}, false
	}
	var header struct {
		Type      string `json:"type"`
		ID        string `json:"id"`
		Timestamp string `json:"timestamp"`
	}
	if json.Unmarshal(headerLine, &header) != nil || header.Type != "session" || header.ID == "" {
		return diskSession{}, false
	}
	createdAt, _ := time.Parse(time.RFC3339Nano, header.Timestamp)
	return diskSession{
		ID:        header.ID,
		Path:      path,
		RecencyMs: createdAt.UnixMilli(),
	}, true
}

func readSessionName(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	reader := bufio.NewReader(f)
	name := ""
	firstUserText := ""
	for {
		line, tooLong, lineErr := readJSONLLine(reader)
		if !tooLong && len(line) > 0 {
			var rec struct {
				Type    string          `json:"type"`
				Name    string          `json:"name"`
				Message json.RawMessage `json:"message"`
			}
			if json.Unmarshal(line, &rec) == nil {
				if rec.Type == "session_info" && rec.Name != "" {
					name = rec.Name
				} else if firstUserText == "" && rec.Type == "message" {
					if text := sessionUserMessageText(rec.Message); text != "" {
						firstUserText = text
					}
				}
			}
		}
		if lineErr != nil {
			if name != "" {
				return name
			}
			return chat.DeriveSessionTitle(firstUserText)
		}
	}
}

// sessionUserMessageText extracts non-empty user text from a JSONL message
// object. content is either a JSON string or an array of parts; the first
// part with type=="text" and non-empty text wins.
func sessionUserMessageText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var msg struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &msg) != nil || msg.Role != "user" {
		return ""
	}
	var text string
	if json.Unmarshal(msg.Content, &text) == nil {
		return text
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(msg.Content, &parts) != nil {
		return ""
	}
	for _, part := range parts {
		if part.Type == "text" && part.Text != "" {
			return part.Text
		}
	}
	return ""
}

// readJSONLLine caps retained data while still draining the complete record, so
// the next call always starts at the next JSONL record. The bool reports that
// the record exceeded the cap and must not be parsed as partial JSON.
func readJSONLLine(r *bufio.Reader) ([]byte, bool, error) {
	line := make([]byte, 0, r.Size())
	tooLong := false
	for {
		fragment, err := r.ReadSlice('\n')
		if !tooLong {
			if len(fragment) > sessionHistoryMaxJSONLLine-len(line) {
				line = nil
				tooLong = true
			} else {
				line = append(line, fragment...)
			}
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		return bytes.TrimSpace(line), tooLong, err
	}
}

// findSessionBranchesByName scans the workspace's per-cwd session directory
// for in-file branch sessions whose name exactly matches chatName: Omo records
// branch sessions as session_info lines inside another session's JSONL instead
// of standalone files, so name is the only join key once the stored path is
// dangling. Bounded by design: at most sessionBranchScanMaxFiles files are
// opened, at most sessionBranchScanMaxCandidates candidates are returned, and
// lines over sessionHistoryMaxJSONLLine are skipped unparsed. A cheap
// bytes.Contains prefilter avoids unmarshaling non-session_info records.
func findSessionBranchesByName(cwd, chatName string) []chat.SessionBranchCandidate {
	if cwd == "" || chatName == "" {
		return nil
	}
	dir := filepath.Join(codingAgentDir(), "sessions", sessionDirNameForCwd(cwd))
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var candidates []chat.SessionBranchCandidate
	files := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}
		if files >= sessionBranchScanMaxFiles || len(candidates) >= sessionBranchScanMaxCandidates {
			break
		}
		files++
		path := filepath.Join(dir, entry.Name())
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		reader := bufio.NewReader(f)
		for len(candidates) < sessionBranchScanMaxCandidates {
			line, tooLong, lineErr := readJSONLLine(reader)
			if !tooLong && len(line) > 0 && bytes.Contains(line, []byte("session_info")) {
				var rec struct {
					Type     string `json:"type"`
					ID       string `json:"id"`
					ParentID string `json:"parentId"`
					Name     string `json:"name"`
				}
				if json.Unmarshal(line, &rec) == nil && rec.Type == "session_info" && rec.Name == chatName {
					candidates = append(candidates, chat.SessionBranchCandidate{
						ID:       rec.ID,
						ParentID: rec.ParentID,
						Name:     rec.Name,
						HostPath: path,
					})
				}
			}
			if lineErr != nil {
				break
			}
		}
		f.Close()
		if len(candidates) >= sessionBranchScanMaxCandidates {
			break
		}
	}
	return candidates
}

func populateSessionHistoryNames(items []sessionHistoryItem) {
	for i := range items {
		if items[i].Source == sessionHistorySourceDiscovered {
			items[i].Name = readSessionName(items[i].ResumeIdentity)
		}
	}
}

func sessionMatchesChat(sess diskSession, chat store.Chat) bool {
	id := strings.TrimSpace(chat.PiSessionID)
	if id == "" {
		return false
	}
	if id == sess.ID || id == sess.Path {
		return true
	}
	base := filepath.Base(id)
	if base == filepath.Base(sess.Path) {
		return true
	}
	return false
}

// chatRecencyMs is the recency key for a stored chat in MRU orderings: the
// last-used stamp when the record carries one, else creation time for legacy
// rows that never recorded a use.
func chatRecencyMs(ch store.Chat) int64 {
	if ch.LastUsedAt > 0 {
		return ch.LastUsedAt
	}
	return ch.CreatedAt
}

func mergeSessionHistory(chats []store.Chat, disk []diskSession) []sessionHistoryItem {
	matched := make([]bool, len(disk))
	items := make([]sessionHistoryItem, 0, len(chats)+len(disk))
	for _, ch := range chats {
		for i, sess := range disk {
			if matched[i] || !sessionMatchesChat(sess, ch) {
				continue
			}
			matched[i] = true
			break
		}
		items = append(items, sessionHistoryItem{
			ID:        ch.ID,
			Name:      ch.Name,
			Source:    sessionHistorySourceStored,
			RecencyMs: chatRecencyMs(ch),
			// A cheap Stat per stored row: flags identities whose session file
			// vanished. Never a branch scan — that is recovery-time work.
			Dangling: chat.StoredIdentityDangling(ch.PiSessionID),
		})
	}
	for i, sess := range disk {
		if matched[i] {
			continue
		}
		items = append(items, sessionHistoryItem{
			ID:             sess.ID,
			Name:           sess.Name,
			Source:         sessionHistorySourceDiscovered,
			RecencyMs:      sess.RecencyMs,
			ResumeIdentity: sess.Path,
		})
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].RecencyMs != items[j].RecencyMs {
			return items[i].RecencyMs > items[j].RecencyMs
		}
		return items[i].ID < items[j].ID
	})
	return items
}

func encodeSessionCursor(recency int64, id string) string {
	raw, err := json.Marshal(sessionHistoryCursor{RecencyMs: recency, ID: id})
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeSessionCursor(cursor string) (sessionHistoryCursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return sessionHistoryCursor{}, err
	}
	var payload sessionHistoryCursor
	if err := json.Unmarshal(raw, &payload); err != nil || payload.ID == "" {
		return sessionHistoryCursor{}, errors.New("invalid cursor")
	}
	return payload, nil
}

func afterSessionCursor(item sessionHistoryItem, cursor sessionHistoryCursor) bool {
	if item.RecencyMs != cursor.RecencyMs {
		return item.RecencyMs < cursor.RecencyMs
	}
	return item.ID > cursor.ID
}

func paginateSessionHistory(items []sessionHistoryItem, limit int, cursor string) (sessionHistoryPage, error) {
	if limit < 1 {
		limit = 1
	}
	if limit > sessionHistoryMaxLimit {
		limit = sessionHistoryMaxLimit
	}
	if items == nil {
		items = []sessionHistoryItem{}
	}
	start := 0
	if cursor != "" {
		payload, err := decodeSessionCursor(cursor)
		if err != nil {
			return sessionHistoryPage{}, err
		}
		for start < len(items) && !afterSessionCursor(items[start], payload) {
			start++
		}
	}
	end := start + limit
	if end > len(items) {
		end = len(items)
	}
	page := items[start:end]
	if page == nil {
		page = []sessionHistoryItem{}
	}
	next := ""
	if end < len(items) && len(page) > 0 {
		last := page[len(page)-1]
		next = encodeSessionCursor(last.RecencyMs, last.ID)
	}
	return sessionHistoryPage{Items: page, NextCursor: next}, nil
}

func parseSessionHistoryLimit(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return sessionHistoryDefaultLimit, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0, err
	}
	if n < 1 {
		return 1, nil
	}
	if n > sessionHistoryMaxLimit {
		return sessionHistoryMaxLimit, nil
	}
	return n, nil
}

func (s *Server) handleListWorkspaceSessions(w http.ResponseWriter, r *http.Request) {
	ws, err := s.store.GetWorkspace(r.PathValue("wsId"))
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	limit, err := parseSessionHistoryLimit(r.URL.Query().Get("limit"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid limit")
		return
	}
	items := mergeSessionHistory(ws.Chats, listDiskSessions(ws.Path))
	page, err := paginateSessionHistory(items, limit, strings.TrimSpace(r.URL.Query().Get("cursor")))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid cursor")
		return
	}
	populateSessionHistoryNames(page.Items)
	writeJSON(w, http.StatusOK, page)
}
