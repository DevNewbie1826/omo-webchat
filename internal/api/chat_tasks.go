package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"unicode/utf8"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
)

const maxChatTaskTextBytes = 512

var (
	errTaskStoreAbsent       = errors.New("task store does not exist")
	errTaskStoreInaccessible = errors.New("task store is inaccessible")
)

type chatTaskRow struct {
	TaskID       string          `json:"task_id"`
	Status       string          `json:"status"`
	Name         string          `json:"name"`
	TaskSummary  string          `json:"task_summary,omitempty"`
	AgentType    string          `json:"agent_type,omitempty"`
	Category     string          `json:"category,omitempty"`
	CreatedAt    string          `json:"created_at,omitempty"`
	UpdatedAt    string          `json:"updated_at,omitempty"`
	LiveProgress json.RawMessage `json:"live_progress,omitempty"`
}

type chatTasksResponse struct {
	ParentSessionID string        `json:"parent_session_id"`
	TruncatedTasks  bool          `json:"truncated_tasks"`
	Tasks           []chatTaskRow `json:"tasks"`
}

type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (r ctxReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}

func (s *Server) taskChatScope(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	workspace, err := s.cursors.GetWorkspace(r.PathValue("wsId"))
	if err != nil {
		s.writeStoreError(w, err)
		return "", "", false
	}
	chat, err := s.cursors.GetChat(r.PathValue("chatId"))
	if err != nil || chat.WorkspaceID != workspace.ID {
		s.writeStoreError(w, cursorstore.ErrNotFound)
		return "", "", false
	}
	cwd, err := validatedChatCWD(workspace.Path, chat.CWD)
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return "", "", false
	}
	return cwd, chat.DurableSessionID, true
}

func (s *Server) handleGetChatTasks(w http.ResponseWriter, r *http.Request) {
	cwd, parent, ok := s.taskChatScope(w, r)
	if !ok {
		return
	}
	rows, err := readChatTaskRows(r.Context(), cwd, parent)
	if err != nil {
		if errors.Is(err, r.Context().Err()) {
			return
		}
		if errors.Is(err, errTaskStoreInaccessible) {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		s.logger.Error("reading chat tasks failed", "chat_id", r.PathValue("chatId"), "err", err)
		writeError(w, http.StatusInternalServerError, "internal server error")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, chatTasksResponse{ParentSessionID: parent, Tasks: rows})
}

func openTaskStore(cwd string) (*os.Root, error) {
	root, err := os.OpenRoot(cwd)
	if err != nil {
		return nil, errTaskStoreInaccessible
	}
	for _, component := range []string{".omo", "senpi-task", "tasks"} {
		before, err := root.Lstat(component)
		if errors.Is(err, os.ErrNotExist) {
			root.Close()
			return nil, errTaskStoreAbsent
		}
		if err != nil || !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
			root.Close()
			return nil, errTaskStoreInaccessible
		}
		next, err := root.OpenRoot(component)
		root.Close()
		if err != nil {
			return nil, errTaskStoreInaccessible
		}
		after, err := next.Stat(".")
		if err != nil || !os.SameFile(before, after) {
			next.Close()
			return nil, errTaskStoreInaccessible
		}
		root = next
	}
	return root, nil
}

func readTaskFile(ctx context.Context, root *os.Root, name string) ([]byte, error) {
	before, err := root.Lstat(name)
	if err != nil || !before.Mode().IsRegular() {
		return nil, nil
	}
	f, err := root.Open(name)
	if err != nil {
		return nil, nil
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !os.SameFile(before, opened) || !opened.Mode().IsRegular() {
		return nil, nil
	}
	data, err := io.ReadAll(ctxReader{ctx: ctx, r: f})
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, nil
	}
	after, err := f.Stat()
	if err != nil || !os.SameFile(opened, after) || opened.Size() != after.Size() || !opened.ModTime().Equal(after.ModTime()) {
		return nil, nil
	}
	return data, nil
}

func readChatTaskRows(ctx context.Context, cwd, parent string) ([]chatTaskRow, error) {
	rows := make([]chatTaskRow, 0)
	if parent == "" {
		return rows, nil
	}
	root, err := openTaskStore(cwd)
	if errors.Is(err, errTaskStoreAbsent) {
		return rows, nil
	}
	if err != nil {
		return nil, err
	}
	defer root.Close()
	dir, err := root.Open(".")
	if err != nil {
		return nil, errTaskStoreInaccessible
	}
	defer dir.Close()
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		entries, readErr := dir.ReadDir(128)
		for _, entry := range entries {
			if filepath.Ext(entry.Name()) != ".json" || entry.Type()&os.ModeSymlink != 0 || entry.IsDir() {
				continue
			}
			data, err := readTaskFile(ctx, root, entry.Name())
			if err != nil {
				return nil, err
			}
			row, owner, ok := projectLiveTaskRow(data)
			if !ok || owner != parent {
				continue
			}
			rows = append(rows, row)
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return nil, errTaskStoreInaccessible
		}
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].CreatedAt == rows[j].CreatedAt {
			return rows[i].TaskID > rows[j].TaskID
		}
		return rows[i].CreatedAt > rows[j].CreatedAt
	})
	return rows, nil
}

func projectLiveTaskRow(data []byte) (chatTaskRow, string, bool) {
	var header struct {
		TaskID          string `json:"task_id"`
		Status          string `json:"status"`
		ParentSessionID string `json:"parent_session_id"`
	}
	if json.Unmarshal(data, &header) != nil || header.TaskID == "" || header.Status == "" {
		return chatTaskRow{}, "", false
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil {
		return chatTaskRow{}, "", false
	}
	name := jsonString(fields["name"])
	if name == "" {
		name = header.TaskID
	}
	row := chatTaskRow{
		TaskID:       header.TaskID,
		Status:       header.Status,
		Name:         clipTaskText(name),
		TaskSummary:  clipTaskText(jsonString(fields["task_summary"])),
		AgentType:    clipTaskText(jsonString(fields["agent_type"])),
		Category:     clipTaskText(jsonString(fields["category"])),
		CreatedAt:    clipTaskText(jsonString(fields["created_at"])),
		UpdatedAt:    jsonString(fields["updated_at"]),
		LiveProgress: projectTaskLiveProgress(fields["live_progress"]),
	}
	return row, header.ParentSessionID, true
}

func projectTaskLiveProgress(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return nil
	}
	out := make(map[string]json.RawMessage)
	for _, key := range []string{"current_tool", "last_assistant_line"} {
		value, ok := jsonStringPresent(fields[key])
		if !ok {
			continue
		}
		encoded, _ := json.Marshal(clipTaskText(value))
		out[key] = encoded
	}
	for _, key := range []string{"turns", "tool_calls", "tokens_per_second"} {
		var n float64
		if json.Unmarshal(fields[key], &n) == nil {
			out[key] = fields[key]
		}
	}
	if len(out) == 0 {
		return nil
	}
	encoded, _ := json.Marshal(out)
	return encoded
}

func jsonString(raw json.RawMessage) string {
	value, _ := jsonStringPresent(raw)
	return value
}

func jsonStringPresent(raw json.RawMessage) (string, bool) {
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	return value, true
}

func clipTaskText(value string) string {
	if len(value) <= maxChatTaskTextBytes {
		return value
	}
	value = value[:maxChatTaskTextBytes]
	for !utf8.ValidString(value) {
		value = value[:len(value)-1]
	}
	return value
}
