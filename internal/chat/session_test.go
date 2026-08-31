package chat

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

type collectWriter struct {
	mu     sync.Mutex
	frames [][]byte
	notify chan struct{}
}

func newCollectWriter() *collectWriter {
	return &collectWriter{notify: make(chan struct{}, 256)}
}

func (c *collectWriter) WriteJSON(b []byte) error {
	c.mu.Lock()
	c.frames = append(c.frames, append([]byte(nil), b...))
	c.mu.Unlock()
	select {
	case c.notify <- struct{}{}:
	default:
	}
	return nil
}

func (c *collectWriter) snapshot() [][]byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([][]byte, len(c.frames))
	for i, f := range c.frames {
		out[i] = append([]byte(nil), f...)
	}
	return out
}

func (c *collectWriter) waitForType(t *testing.T, typ string, timeout time.Duration) [][]byte {
	t.Helper()
	deadline := time.After(timeout)
	for {
		for _, f := range c.snapshot() {
			var env struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(f, &env) == nil && env.Type == typ {
				return c.snapshot()
			}
		}
		select {
		case <-c.notify:
		case <-deadline:
			t.Fatalf("timed out waiting for frame %q; got: %s", typ, c.typesString())
		}
	}
}

// waitFor blocks until pred passes over the accumulated frames. Frame arrival
// notifies through c.notify, so waiting is event-driven with no polling sleep;
// the timeout only detects failure.
func (c *collectWriter) waitFor(t *testing.T, timeout time.Duration, desc string, pred func([][]byte) bool) [][]byte {
	t.Helper()
	deadline := time.After(timeout)
	for {
		frames := c.snapshot()
		if pred(frames) {
			return frames
		}
		select {
		case <-c.notify:
		case <-deadline:
			t.Fatalf("timed out waiting for %s; got: %s", desc, c.typesString())
		}
	}
}

func (c *collectWriter) typesString() string {
	var sb strings.Builder
	for _, f := range c.snapshot() {
		var env struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(f, &env)
		sb.WriteString(env.Type)
		sb.WriteByte(' ')
	}
	return sb.String()
}

func startMockSession(t *testing.T, id string, env ...string) (*Session, *collectWriter) {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	script := filepath.Join(filepath.Dir(file), "..", "..", "test", "mock-pi", "mock-pi.mjs")
	if _, err := os.Stat(script); err != nil {
		t.Skipf("mock-pi not found: %v", err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	w := newCollectWriter()
	s, err := StartSession(context.Background(), SessionOptions{
		ID:     id,
		Binary: node,
		Args:   []string{script},
		Env:    append(os.Environ(), env...),
	})
	if err != nil {
		t.Fatalf("start session: %v", err)
	}
	s.Attach(w)
	return s, w
}

func TestSession_StreamMapsToNormalizedFrames(t *testing.T) {
	s, w := startMockSession(t, "chat-1", "MOCK_PI_UNICODE=1", "MOCK_PI_CHUNKS=2")
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("close session: %v", err)
		}
	})

	if err := s.SendPrompt("hello", nil); err != nil {
		t.Fatalf("send prompt: %v", err)
	}
	frames := w.waitForType(t, "run.done", 5*time.Second)

	deltas := 0
	sawMessage := false
	sawUnicode := false
	for _, f := range frames {
		var env struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(f, &env)
		switch env.Type {
		case "messageDelta":
			var d MessageDeltaFrame
			if json.Unmarshal(f, &d) == nil && d.Delta.Kind == "text_delta" {
				deltas++
			}
			if d.Delta.Kind == "text_end" && strings.Contains(d.Delta.Content, "\u2028") {
				sawUnicode = true
			}
		case "message":
			sawMessage = true
		}
	}
	if deltas != 2 {
		t.Fatalf("expected 2 text_delta frames, got %d (frames: %s)", deltas, w.typesString())
	}
	if !sawMessage {
		t.Fatalf("expected a finalized message frame (frames: %s)", w.typesString())
	}
	if !sawUnicode {
		t.Fatalf("U+2028 not present in streamed text_end content")
	}
}

func TestSession_ApprovalRoundTrip(t *testing.T) {
	s, w := startMockSession(t, "chat-2", "MOCK_PI_APPROVE=1", "MOCK_PI_CHUNKS=2")
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("close session: %v", err)
		}
	})

	if err := s.SendPrompt("do a thing", nil); err != nil {
		t.Fatalf("send prompt: %v", err)
	}
	frames := w.waitForType(t, "approval", 5*time.Second)

	var approval ApprovalFrame
	for _, f := range frames {
		var env struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(f, &env) == nil && env.Type == "approval" {
			_ = json.Unmarshal(f, &approval)
			break
		}
	}
	if approval.ID == "" || approval.Method != "select" {
		t.Fatalf("approval frame not mapped: %+v", approval)
	}

	tTrue := true
	if err := s.RespondApproval(approval.ID, "", &tTrue, nil, nil); err != nil {
		t.Fatalf("respond approval: %v", err)
	}
	w.waitForType(t, "run.done", 5*time.Second)

	sawTextAfter := false
	for _, f := range w.snapshot() {
		var d MessageDeltaFrame
		if json.Unmarshal(f, &d) == nil && d.Type == "messageDelta" && d.Delta.Kind == "text_delta" {
			sawTextAfter = true
		}
	}
	if !sawTextAfter {
		t.Fatalf("expected streamed text after approval Allow (frames: %s)", w.typesString())
	}
}
