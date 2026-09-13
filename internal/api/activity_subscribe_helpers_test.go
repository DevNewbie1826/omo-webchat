package api

import (
	"encoding/json"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/lxzan/gws"
	"sync"
	"testing"
	"time"
)

type activityE2ESource struct {
	manager   *session.Manager
	published chan session.Summary
}

func (s *activityE2ESource) SubscribeActivity(allLive bool, sessionIDs []string, publish func(session.Summary, bool)) ([]session.Summary, func()) {
	return s.manager.SubscribeActivity(allLive, sessionIDs, func(summary session.Summary, overflow bool) {
		publish(summary, overflow)
		s.published <- summary
	})
}

type activityE2ECollector struct {
	gws.BuiltinEventHandler
	mu     sync.Mutex
	frames []map[string]any
	notify chan struct{}
}

func (c *activityE2ECollector) OnMessage(_ *gws.Conn, message *gws.Message) {
	defer message.Close()
	var frame map[string]any
	if json.Unmarshal(message.Bytes(), &frame) != nil {
		return
	}
	c.mu.Lock()
	c.frames = append(c.frames, frame)
	c.mu.Unlock()
	select {
	case c.notify <- struct{}{}:
	default:
	}
}

func (c *activityE2ECollector) next(t *testing.T, typ string) map[string]any {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		c.mu.Lock()
		for i, frame := range c.frames {
			if frame["type"] == typ {
				c.frames = append(c.frames[:i], c.frames[i+1:]...)
				c.mu.Unlock()
				return frame
			}
		}
		c.mu.Unlock()
		select {
		case <-c.notify:
		case <-timer.C:
			t.Fatalf("timed out waiting for %s", typ)
		}
	}
}

func writeActivityE2EFrame(t *testing.T, conn *gws.Conn, frame any) {
	t.Helper()
	raw, err := json.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteMessage(gws.OpcodeText, raw); err != nil {
		t.Fatal(err)
	}
}

func assertEngineActivityPayload(t *testing.T, name string, expected, value any) {
	t.Helper()
	want, err := json.Marshal(expected)
	if err != nil {
		t.Fatal(err)
	}
	got, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatalf("%s payload lost fidelity:\nwant %s\n got %s", name, want, got)
	}
	payload, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("%s payload type = %T", name, value)
	}
	switch name {
	case "omo.task.updated":
		tasks, ok := payload["tasks"].([]any)
		if !ok || len(tasks) != 2 {
			t.Fatalf("engine task list = %v", payload["tasks"])
		}
		first := tasks[0].(map[string]any)
		runStats, statsOK := first["run_stats"].(map[string]any)
		liveProgress, progressOK := first["live_progress"].(map[string]any)
		if first["child_session_id"] != "child-session-1" || !statsOK || runStats["runtime_ms"] != float64(2000) || !progressOK || liveProgress["current_tool"] != "read" {
			t.Fatalf("engine task detail lost fidelity: %v", first)
		}
	case "omo.dag.updated":
		runs, ok := payload["runs"].([]any)
		if !ok || len(runs) != 1 {
			t.Fatalf("engine DAG runs = %v", payload["runs"])
		}
		run := runs[0].(map[string]any)
		nodes, nodesOK := run["nodes"].([]any)
		edges, edgesOK := run["edges"].([]any)
		waves, wavesOK := run["waves"].([]any)
		if run["run_key"] != "phase-c" || !nodesOK || len(nodes) != 2 || !edgesOK || len(edges) != 1 || !wavesOK || len(waves) != 2 {
			t.Fatalf("engine DAG detail lost fidelity: %v", run)
		}
	}
}
