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
	"sync"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
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

	// DiscoveredStabilityWindow is how long a freshly written disk session is
	// held out of the discovered catalog while some stored chat in the same
	// workspace still dangles. Observed engine behavior: a session's jsonl is
	// created lazily on first persist, so a brand-new file can be the missing
	// half of a dangling stored chat rather than a distinct session. Exposing
	// it immediately makes one user-perceived chat flicker between one and
	// two rows for as long as the persist takes (seconds to minutes).
	// A row clears the gate once its mtime has aged this long or it has been
	// observed in this process for this long, whichever comes first, so a
	// legitimate session whose mtime keeps refreshing does not stay hidden.
	DiscoveredStabilityWindow = 90 * time.Second
)

// now is the catalog clock. Tests replace it to age sessions deterministically
// instead of sleeping.
var now = time.Now

// discoveredFirstSeen is the first catalog observation of each disk session in
// this process, keyed by durable id (or path if id is empty). It does not move
// when the file is rewritten.
var discoveredFirstSeen = struct {
	mu sync.Mutex
	m  map[string]time.Time
}{m: make(map[string]time.Time)}

type sessionHistoryItem struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Source         string `json:"source"`
	RecencyMs      int64  `json:"recencyMs"`
	ResumeIdentity string `json:"resumeIdentity,omitempty"`
	// Dangling flags a stored row whose owned session copy is gone. Source
	// catalog rows never set it.
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

func codingAgentDir() string { return session.CodingAgentDir() }

// sessionDirNameForCwd delegates to the shared session-package encoder so the
// disk-session lister and the goal-state reader agree on one layout.
func sessionDirNameForCwd(cwd string) string { return session.SessionDirNameForCwd(cwd) }

func listDiskSessions(cwd string) []diskSession {
	agentDir := codingAgentDir()
	canonicalCWD, ok := canonicalSessionCWD(cwd)
	if agentDir == "" || !ok {
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
		headerCWD, ok := canonicalSessionCWD(sess.CWD)
		if !ok || headerCWD != canonicalCWD {
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
	return diskSession{
		ID:        header.ID,
		Path:      path,
		CWD:       header.CWD,
		RecencyMs: createdAt.UnixMilli(),
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
			return deriveSessionTitle(firstUserText), false
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

func deriveSessionTitle(prompt string) string { return session.DeriveSessionTitle(prompt) }

func populateSessionHistoryNames(items []sessionHistoryItem) {
	for i := range items {
		if items[i].Source != sessionHistorySourceStored {
			items[i].Name = readSessionName(items[i].ResumeIdentity)
		}
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

// chatRecencyMs is the recency key for a stored chat in MRU orderings: the
// last-used stamp when the record carries one, else creation time for legacy
// rows that never recorded a use.
func chatRecencyMs(ch cursorstore.Chat) int64 {
	return cursorstore.RecencyMillis(ch)
}

func mergeSessionHistory(chats []cursorstore.Chat, disk []diskSession) []sessionHistoryItem {
	items := make([]sessionHistoryItem, 0, len(chats)+len(disk))
	danglingCWDs := make(map[string]struct{})
	for _, ch := range chats {
		danglingRow := storedIdentityDangling(ch.SessionFile)
		if canonicalCWD, ok := canonicalSessionCWD(ch.CWD); danglingRow && ok {
			danglingCWDs[canonicalCWD] = struct{}{}
		}
		items = append(items, sessionHistoryItem{
			ID:        ch.ID,
			Name:      ch.Name,
			Source:    sessionHistorySourceStored,
			RecencyMs: chatRecencyMs(ch),
			// A cheap Stat per stored row flags an owned copy that vanished.
			// Never a branch scan — that is recovery-time work.
			Dangling: danglingRow,
		})
	}
	for _, sess := range disk {
		noteDiscoveredSessionObservation(sess)
		suppress := false
		for _, chat := range chats {
			// The stored row already represents this durable session regardless
			// of how the chat acquired it. Match only concrete identity fields.
			if sessionMatchesChat(sess, chat) {
				suppress = true
				break
			}
		}
		// While a stored chat in the same cwd still dangles, a freshly written
		// disk session may be that chat's lazy first persist rather than a
		// distinct session. Hold it out of the catalog until it has been
		// stable for the window — mtime aged or observed that long — or no
		// same-cwd dangling chat remains, so the user sees one row instead of
		// a transient duplicate. Once the chat's identity is updated onto the
		// file — takeover or adoption — the identity match above merges it
		// into the stored row immediately.
		canonicalCWD, canonical := canonicalSessionCWD(sess.CWD)
		_, sameCWDDangling := danglingCWDs[canonicalCWD]
		if suppress || (canonical && sameCWDDangling && discoveredSessionUnstable(sess)) {
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

func storedIdentityDangling(path string) bool {
	if path == "" || !filepath.IsAbs(path) {
		return false
	}
	_, err := os.Stat(path)
	return errors.Is(err, os.ErrNotExist)
}

// discoveredSessionUnstable reports whether a disk session is still too new to
// expose as a discovered catalog row while a same-cwd stored chat dangles.
// A row is unstable only while BOTH its file mtime AND its first catalog
// observation are within DiscoveredStabilityWindow of now. First-seen does not
// move when the file is rewritten, so a legitimate active session whose mtime
// keeps refreshing still becomes visible once it has been observed for the
// window. Rows with an unknown modification time are never treated as unstable.
func discoveredSessionUnstable(sess diskSession) bool {
	if sess.ModTime.IsZero() {
		return false
	}
	current := now()
	if current.Sub(sess.ModTime) >= DiscoveredStabilityWindow {
		return false
	}
	return current.Sub(noteDiscoveredSessionObservation(sess)) < DiscoveredStabilityWindow
}

func discoveredSessionIdentity(sess diskSession) string {
	if id := strings.TrimSpace(sess.ID); id != "" {
		return id
	}
	return strings.TrimSpace(sess.Path)
}

func noteDiscoveredSessionObservation(sess diskSession) time.Time {
	key := discoveredSessionIdentity(sess)
	seen := now()
	if key == "" {
		return seen
	}
	discoveredFirstSeen.mu.Lock()
	defer discoveredFirstSeen.mu.Unlock()
	if t, ok := discoveredFirstSeen.m[key]; ok {
		return t
	}
	discoveredFirstSeen.m[key] = seen
	return seen
}

func resetDiscoveredSessionFirstSeen() {
	discoveredFirstSeen.mu.Lock()
	discoveredFirstSeen.m = make(map[string]time.Time)
	discoveredFirstSeen.mu.Unlock()
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
	items := mergeSessionHistory(chats, listDiskSessions(ws.Path))
	page, err := paginateSessionHistory(items, limit, strings.TrimSpace(r.URL.Query().Get("cursor")))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid cursor")
		return
	}
	populateSessionHistoryNames(page.Items)
	writeJSON(w, http.StatusOK, page)
}
