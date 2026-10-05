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

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

const (
	sessionHistoryDefaultLimit = 5
	sessionHistoryMaxLimit     = 5
	sessionHistoryMaxJSONLLine = 1 << 20 // 1 MiB; metadata records are normally only a few KiB.
	sessionHistorySourceStored = "stored"
	// Bounds for the dangling-recovery branch scan: at most this many session
	// files are opened, and at most this many candidates are returned.
	sessionBranchScanMaxFiles      = 32
	sessionBranchScanMaxCandidates = 8
)

// now is the enrollment clock. Tests replace it deterministically.
var now = time.Now

type sessionHistoryItem struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	Source           string `json:"source"`
	RecencyMs        int64  `json:"recencyMs"`
	DurableSessionID string `json:"durableSessionID,omitempty"`
	Live             bool   `json:"live,omitempty"`
	// Dangling flags a stored row whose session file is gone.
	Dangling bool `json:"dangling,omitempty"`
	// Preparing flags a live stored chat whose session file is missing. A
	// live chat's file is written on the next persist, so absence under a
	// live session is pending persistence; "missing original" is reserved
	// for a chat with no file and no live session.
	Preparing bool `json:"preparing,omitempty"`
}

type sessionHistoryPage struct {
	Items      []sessionHistoryItem `json:"items"`
	NextCursor string               `json:"nextCursor"`
}

type diskSession struct {
	ID        string
	Name      string
	Path      string
	CWD       string
	RecencyMs int64
	// ModTime is the session file's modification time, captured when the file
	// is parsed. Zero for hand-built rows, which disables the freshness gate.
	ModTime time.Time
}

type sessionHistoryCursor struct {
	RecencyMs int64  `json:"r"`
	ID        string `json:"i"`
}

// sessionDirNameForCwd delegates to the shared session-package encoder so the
// disk-session lister and the goal-state reader agree on one layout.
func sessionDirNameForCwd(cwd string) string { return session.SessionDirNameForCwd(cwd) }

func listDiskSessions(cwd string) ([]diskSession, bool) {
	agentDir := session.CodingAgentDir()
	canonicalCWD, ok := canonicalSessionCWD(cwd)
	if agentDir == "" || !ok {
		return nil, false
	}
	dir := filepath.Join(agentDir, "sessions", sessionDirNameForCwd(cwd))
	// Windows ReadDir can report ErrNotExist for an existing regular file.
	// Only an absent directory is a successful empty scan.
	f, err := os.Open(dir)
	if err != nil {
		return nil, errors.Is(err, os.ErrNotExist)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.IsDir() {
		return nil, false
	}
	entries, err := f.ReadDir(-1)
	if err != nil {
		return nil, false
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	out := make([]diskSession, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}
		sess, ok := parseSessionFile(filepath.Join(dir, entry.Name()))
		if !ok {
			continue
		}
		headerCWD, ok := canonicalSessionCWD(sess.CWD)
		if !ok || headerCWD != canonicalCWD {
			continue
		}
		out = append(out, sess)
	}
	return out, true
}

func canonicalSessionCWD(path string) (string, bool) {
	if !filepath.IsAbs(path) {
		return "", false
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(path))
	if err != nil {
		return "", false
	}
	return filepath.Clean(resolved), true
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
		CWD       string `json:"cwd"`
	}
	if json.Unmarshal(headerLine, &header) != nil || header.Type != "session" || header.ID == "" || header.CWD == "" {
		return diskSession{}, false
	}
	createdAt, _ := time.Parse(time.RFC3339Nano, header.Timestamp)
	var modTime time.Time
	if info, statErr := f.Stat(); statErr == nil {
		modTime = info.ModTime()
	}
	recency := int64(0)
	if !modTime.IsZero() && modTime.UnixMilli() > 0 {
		recency = modTime.UnixMilli()
	} else if !createdAt.IsZero() && createdAt.UnixMilli() > 0 {
		recency = createdAt.UnixMilli()
	}
	return diskSession{
		ID:        header.ID,
		Path:      path,
		CWD:       header.CWD,
		RecencyMs: recency,
		ModTime:   modTime,
	}, true
}

func readSessionName(path string) string {
	name, _ := readSessionNameSource(path)
	return name
}

// readSessionNameSource distinguishes a durable session_info name from the
// catalog-only fallback derived from the first user message.
func readSessionNameSource(path string) (name string, established bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer f.Close()

	reader := bufio.NewReader(f)
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
				if rec.Type == "session_info" && strings.TrimSpace(rec.Name) != "" {
					name = strings.TrimSpace(rec.Name)
					established = true
				} else if firstUserText == "" && rec.Type == "message" {
					if text := sessionUserMessageText(rec.Message); text != "" {
						firstUserText = text
					}
				}
			}
		}
		if lineErr != nil {
			if established {
				return name, true
			}
			return session.DeriveSessionTitle(firstUserText), false
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

func sessionMatchesChat(sess diskSession, chat cursorstore.Chat) bool {
	durableID := strings.TrimSpace(chat.DurableSessionID)
	sessionFile := strings.TrimSpace(chat.SessionFile)
	// A recorded durable id is authoritative: the same path with a different
	// id is a distinct replacement session and must not match, and a stored
	// chat must never rebind onto it. The path only disambiguates rows that
	// never recorded a durable id.
	if sess.ID != "" && durableID != "" {
		return durableID == sess.ID
	}
	return durableID != "" && durableID == sess.ID || sessionFile != "" && sessionFile == sess.Path
}

func mergeSessionHistory(chats []cursorstore.Chat, disk []diskSession) []sessionHistoryItem {
	return mergeSessionHistoryLive(chats, disk, nil)
}

func mergeSessionHistoryLive(chats []cursorstore.Chat, disk []diskSession, liveChatIDs map[string]struct{}) []sessionHistoryItem {
	items := make([]sessionHistoryItem, 0, len(chats))
	for _, ch := range chats {
		missingFile := storedIdentityDangling(ch.SessionFile)
		_, live := liveChatIDs[ch.ID]
		preparing := missingFile && live
		items = append(items, sessionHistoryItem{
			ID:               ch.ID,
			Name:             ch.Name,
			Source:           sessionHistorySourceStored,
			DurableSessionID: ch.DurableSessionID,
			RecencyMs:        chatRecencyMs(ch, disk),
			// A cheap Stat per stored row flags an owned copy that vanished.
			// Never a branch scan — that is recovery-time work.
			Dangling:  missingFile && !preparing,
			Preparing: preparing,
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

func storedIdentityDangling(path string) bool {
	if path == "" || !filepath.IsAbs(path) {
		return false
	}
	_, err := os.Stat(path)
	return errors.Is(err, os.ErrNotExist)
}

func (s *Server) handleListWorkspaceSessions(w http.ResponseWriter, r *http.Request) {
	ws, err := s.cursors.GetWorkspace(r.PathValue("wsId"))
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	limit, err := parseSessionHistoryLimit(r.URL.Query().Get("limit"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid limit")
		return
	}
	chats := s.cursors.ListChats(ws.ID)
	// Disk metadata only contributes recency to stored chats; it never adds rows.
	disk, _ := listDiskSessions(ws.Path)
	var live map[string]struct{}
	if s.manager != nil {
		summaries := s.manager.LiveSummaries()
		live = make(map[string]struct{}, len(summaries))
		for _, summary := range summaries {
			live[summary.ChatID] = struct{}{}
		}
	}
	items := mergeSessionHistoryLive(chats, disk, live)
	for i := range items {
		for _, chat := range chats {
			if chat.ID == items[i].ID {
				items[i].Live = s.enrollmentLive(chat)
				if items[i].Live && items[i].Dangling {
					items[i].Dangling, items[i].Preparing = false, true
				}
				break
			}
		}
	}
	page, err := paginateSessionHistory(items, limit, strings.TrimSpace(r.URL.Query().Get("cursor")))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid cursor")
		return
	}
	writeJSON(w, http.StatusOK, page)
}
