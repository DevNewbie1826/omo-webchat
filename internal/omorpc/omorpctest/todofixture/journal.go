package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

const durableID = "todo-qa-durable"
const chatID = "todo-qa-chat"
const workspaceID = "todo-qa-workspace"

type journal struct {
	mu        sync.Mutex
	path      string
	cwd       string
	entries   []map[string]any
	leaf      string
	serial    int
	persisted int
	failRead  bool
	gate      *readGate
	gates     map[string]*readGate
}
type readGate struct {
	token     string
	entered   chan struct{}
	release   chan struct{}
	completed chan struct{}
	once      sync.Once
	snapshot  map[string]any
}

func newJournal(root string) (*journal, error) {
	j := &journal{path: filepath.Join(root, "session.jsonl"), cwd: root, gates: make(map[string]*readGate)}
	for i := 0; i < 160; i++ {
		role := "user"
		if i%2 != 0 {
			role = "assistant"
		}
		j.appendLocked(map[string]any{"type": "message", "message": map[string]any{"role": role, "content": fmt.Sprintf("todo-transcript-%03d\n\n%s", i, repeatTranscript())}}, "")
	}
	j.appendLocked(map[string]any{"type": "custom", "customType": "senpi.todo-state", "data": map[string]any{"schema": "v2", "phases": []any{map[string]any{"name": "검증", "tasks": []any{map[string]any{"content": "복원 항목 A", "status": "pending"}}}}}}, "")
	return j, j.persistLocked()
}
func repeatTranscript() string {
	var b bytes.Buffer
	for i := 0; i < 12; i++ {
		b.WriteString("저장된 긴 대화에서 최신 작업 목록과 명시적인 초기화를 확인합니다. Long transcript synthetic fixture. ")
	}
	return b.String()
}
func (j *journal) appendLocked(entry map[string]any, parent string) string {
	j.serial++
	id := fmt.Sprintf("todo-entry-%04d", j.serial)
	if parent == "" {
		parent = j.leaf
	}
	entry["id"] = id
	entry["parentId"] = nil
	if parent != "" {
		entry["parentId"] = parent
	}
	entry["timestamp"] = "2026-09-07T10:00:00.000Z" // Deliberately not a revision.
	j.entries = append(j.entries, entry)
	j.leaf = id
	return id
}
func (j *journal) append(entry map[string]any, parent string, persist bool) (string, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if parent != "" {
		found := false
		for _, row := range j.entries {
			if row["id"] == parent {
				found = true
				break
			}
		}
		if !found {
			return "", errors.New("unknown parent")
		}
	}
	id := j.appendLocked(entry, parent)
	if persist {
		return id, j.persistLocked()
	}
	return id, nil
}
func (j *journal) persistLocked() error {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	if j.persisted == 0 {
		if err := enc.Encode(map[string]any{"type": "session", "version": 3, "id": durableID, "cwd": j.cwd, "timestamp": "2026-09-07T10:00:00.000Z"}); err != nil {
			return err
		}
	}
	for _, row := range j.entries[j.persisted:] {
		if err := enc.Encode(row); err != nil {
			return err
		}
	}
	// Ordinary provider persistence appends to the same identity. Replacing the
	// inode would correctly trip production's external-write protection.
	file, err := os.OpenFile(j.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	if _, err := file.Write(b.Bytes()); err != nil {
		return errors.Join(err, file.Close())
	}
	if err := file.Sync(); err != nil {
		return errors.Join(err, file.Close())
	}
	if err := file.Close(); err != nil {
		return err
	}
	j.persisted = len(j.entries)
	return nil
}
func (j *journal) response(req map[string]any) (map[string]any, *readGate) {
	j.mu.Lock()
	defer j.mu.Unlock()
	response := map[string]any{"type": "response", "id": req["id"], "command": "get_entries", "sessionId": req["sessionId"], "success": true}
	start := 0
	since, _ := req["since"].(string)
	if since != "" {
		start = -1
		for i, row := range j.entries {
			if row["id"] == since {
				start = i + 1
				break
			}
		}
	}
	if j.failRead {
		response["success"] = false
		response["error"] = "QA_READ_FAILURE"
	} else if start < 0 {
		response["success"] = false
		response["error"] = "Entry not found: " + since
	} else {
		// Deep copy: a held response is a real captured old acquisition, not a late
		// lookup that silently reads the replacement state when released.
		raw, err := json.Marshal(j.entries[start:])
		var entries []any
		if err == nil {
			err = json.Unmarshal(raw, &entries)
		}
		if err != nil {
			response["success"] = false
			response["error"] = fmt.Sprintf("fixture history encoding: %v", err)
		} else {
			if entries == nil {
				entries = []any{}
			}
			response["data"] = map[string]any{"entries": entries, "leafId": j.leaf}
		}
	}
	gate := j.gate
	if gate != nil {
		j.gate = nil
		gate.snapshot = response
		close(gate.entered)
	}
	return response, gate
}
func (j *journal) arm() (string, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.gate != nil {
		return "", errors.New("read already armed")
	}
	token := fmt.Sprintf("read-%d", len(j.gates)+1)
	g := &readGate{token: token, entered: make(chan struct{}), release: make(chan struct{}), completed: make(chan struct{})}
	j.gates[token] = g
	j.gate = g
	return token, nil
}
func (j *journal) getGate(token string) (*readGate, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	g := j.gates[token]
	if g == nil {
		return nil, errors.New("unknown read token")
	}
	return g, nil
}
func (j *journal) releaseAll() {
	j.mu.Lock()
	defer j.mu.Unlock()
	for _, g := range j.gates {
		g.once.Do(func() { close(g.release) })
	}
}
