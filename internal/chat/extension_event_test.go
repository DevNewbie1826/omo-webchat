package chat

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// mockExtEventTaskData mirrors the data payload mock-pi emits under
// MOCK_PI_EXT_EVENT=1. The forwarding contract is verbatim passthrough, so
// the client frame must carry exactly this object.
const mockExtEventTaskData = `{"task":{"id":"st_mock_001","name":"st_mock","title":"Quick category agent","status":"running","category":"quick"}}`

// mockExtEventDagData mirrors the omo.dag.updated payload mock-pi emits in
// the same turn: the second snapshot event replayed alongside the task one.
const mockExtEventDagData = `{"dag":{"nodes":[{"id":"st_mock_001","status":"running"}],"edges":[]}}`

// extEventEnvelope is the parsed shape of an "extensionEvent" client frame.
type extEventEnvelope struct {
	Type      string          `json:"type"`
	SessionID string          `json:"sessionId"`
	Name      string          `json:"name"`
	Data      json.RawMessage `json:"data"`
}

func collectExtEventFrames(t *testing.T, frames [][]byte) []extEventEnvelope {
	t.Helper()
	var out []extEventEnvelope
	for _, f := range frames {
		var env extEventEnvelope
		if json.Unmarshal(f, &env) == nil && env.Type == "extensionEvent" {
			out = append(out, env)
		}
	}
	return out
}

func extEventNames(events []extEventEnvelope) []string {
	names := make([]string, len(events))
	for i, ev := range events {
		names[i] = ev.Name
	}
	return names
}

// A provider extension_event must reach attached clients as exactly one
// "extensionEvent" frame: sessionId rewritten, name and data passed through
// verbatim. mock-pi emits a valid frame plus a nameless one per turn; the
// nameless one must never surface.
func TestExtensionEventForwardedToClients(t *testing.T) {
	s, w := startMockSession(t, "chat-ext-event", "MOCK_PI_EXT_EVENT=1")
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("close session: %v", err)
		}
	})

	if err := s.SendPrompt("hello", nil); err != nil {
		t.Fatalf("send prompt: %v", err)
	}
	frames := w.waitForType(t, "run.done", 5*time.Second)

	forwarded := collectExtEventFrames(t, frames)
	if names := extEventNames(forwarded); !reflect.DeepEqual(names, []string{"omo.task.updated", "omo.dag.updated"}) {
		t.Fatalf("extensionEvent names = %v, want exactly [omo.task.updated omo.dag.updated] (valid forwarded, nameless dropped); frames: %s", names, w.typesString())
	}
	ev := forwarded[0]
	if ev.SessionID != "chat-ext-event" {
		t.Fatalf("extensionEvent sessionId = %q, want chat-ext-event", ev.SessionID)
	}
	var gotTask, wantTask any
	if err := json.Unmarshal(ev.Data, &gotTask); err != nil {
		t.Fatalf("task data is not valid JSON: %v (%s)", err, ev.Data)
	}
	if err := json.Unmarshal([]byte(mockExtEventTaskData), &wantTask); err != nil {
		t.Fatalf("fixture data is not valid JSON: %v", err)
	}
	if !reflect.DeepEqual(gotTask, wantTask) {
		t.Fatalf("task data = %s, want %s", ev.Data, mockExtEventTaskData)
	}
	var gotDag, wantDag any
	if err := json.Unmarshal(forwarded[1].Data, &gotDag); err != nil {
		t.Fatalf("dag data is not valid JSON: %v (%s)", err, forwarded[1].Data)
	}
	if err := json.Unmarshal([]byte(mockExtEventDagData), &wantDag); err != nil {
		t.Fatalf("fixture data is not valid JSON: %v", err)
	}
	if !reflect.DeepEqual(gotDag, wantDag) {
		t.Fatalf("dag data = %s, want %s", forwarded[1].Data, mockExtEventDagData)
	}
}

// A nameless extension_event cannot be routed by consumers and must be
// dropped without disturbing the session; a named one in the same shape is
// forwarded.
func TestExtensionEventNamelessDropped(t *testing.T) {
	writer := newCollectWriter()
	s := newTestSession("chat-ext-drop", writer)

	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.task.updated","data":{"ok":true}}`)
	if got := countFramesOfType(writer.snapshot(), "extensionEvent"); got != 1 {
		t.Fatalf("named extension_event forwarded = %d, want 1; frames: %s", got, writer.typesString())
	}

	dispatchEvent(s, "extension_event", `{"type":"extension_event"}`)
	if got := countFramesOfType(writer.snapshot(), "extensionEvent"); got != 1 {
		t.Fatalf("nameless extension_event forwarded = %d, want still 1; frames: %s", got, writer.typesString())
	}
}

// A client that attaches after a turn must receive the last
// omo.task.updated and omo.dag.updated snapshots as replayed extensionEvent
// frames — task first, dag second, payloads verbatim — while the subscriber
// attached before the turn receives no duplicates.
func TestExtensionEventSnapshotsReplayedToLateSubscriber(t *testing.T) {
	s, w := startMockSession(t, "chat-ext-replay", "MOCK_PI_EXT_EVENT=1")
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("close session: %v", err)
		}
	})

	if err := s.SendPrompt("hello", nil); err != nil {
		t.Fatalf("send prompt: %v", err)
	}
	w.waitForType(t, "run.done", 5*time.Second)
	live := collectExtEventFrames(t, w.snapshot())
	if names := extEventNames(live); !reflect.DeepEqual(names, []string{"omo.task.updated", "omo.dag.updated"}) {
		t.Fatalf("live extensionEvent names = %v, want [omo.task.updated omo.dag.updated]; frames: %s", names, w.typesString())
	}

	// Attach is synchronous: the replay has been written when it returns.
	late := newCollectWriter()
	s.Attach(late)
	replayed := collectExtEventFrames(t, late.snapshot())
	if names := extEventNames(replayed); !reflect.DeepEqual(names, []string{"omo.task.updated", "omo.dag.updated"}) {
		t.Fatalf("replayed extensionEvent names = %v, want exactly [omo.task.updated omo.dag.updated] (task first); frames: %s", names, late.typesString())
	}
	if replayed[0].SessionID != "chat-ext-replay" {
		t.Fatalf("replayed frame sessionId = %q, want chat-ext-replay", replayed[0].SessionID)
	}
	for i, want := range []string{mockExtEventTaskData, mockExtEventDagData} {
		var got, expected any
		if err := json.Unmarshal(replayed[i].Data, &got); err != nil {
			t.Fatalf("replayed frame %d data is not valid JSON: %v (%s)", i, err, replayed[i].Data)
		}
		if err := json.Unmarshal([]byte(want), &expected); err != nil {
			t.Fatalf("fixture data is not valid JSON: %v", err)
		}
		if !reflect.DeepEqual(got, expected) {
			t.Fatalf("replayed frame %d data = %s, want %s", i, replayed[i].Data, want)
		}
	}

	// The pre-existing subscriber must not see the replay.
	if after := collectExtEventFrames(t, w.snapshot()); len(after) != len(live) {
		t.Fatalf("extensionEvent frames after replay = %d, want still %d (no rebroadcast); frames: %s", len(after), len(live), w.typesString())
	}
}

// Transient activity traffic (omo.dag.activity, omo.dag.heartbeat) forwards
// live but is never cached: a late subscriber replays only snapshot events.
type cancellableReplayWriter struct {
	mu      sync.Mutex
	frames  [][]byte
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (w *cancellableReplayWriter) WriteJSON(frame []byte) error {
	w.mu.Lock()
	w.frames = append(w.frames, append([]byte(nil), frame...))
	first := len(w.frames) == 1
	w.mu.Unlock()
	if first {
		close(w.entered)
		<-w.release
	}
	return nil
}

func (w *cancellableReplayWriter) Close() error {
	w.once.Do(func() { close(w.release) })
	return nil
}

func (w *cancellableReplayWriter) snapshot() [][]byte {
	w.mu.Lock()
	defer w.mu.Unlock()
	frames := make([][]byte, len(w.frames))
	for i, frame := range w.frames {
		frames[i] = append([]byte(nil), frame...)
	}
	return frames
}

func TestActivitySnapshotReplayPrecedesFollowingLiveFrame(t *testing.T) {
	s := newTestSession("chat-ext-replay-order", nil)
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.task.updated","data":{"task":1}}`)
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.dag.updated","data":{"dag":1}}`)

	writer := &cancellableReplayWriter{entered: make(chan struct{}), release: make(chan struct{})}
	attached := make(chan struct{})
	go func() {
		s.Attach(writer)
		close(attached)
	}()
	select {
	case <-writer.entered:
	case <-time.After(time.Second):
		t.Fatal("first cached snapshot did not enter replay")
	}

	liveDelivered := make(chan struct{})
	go func() {
		dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.dag.heartbeat","data":{"live":true}}`)
		close(liveDelivered)
	}()

	// Replay is an active broadcaster delivery, so cancellation releases the
	// blocked writer without allowing the following live frame to overtake it.
	s.frames.cancelActive()
	select {
	case <-attached:
	case <-time.After(time.Second):
		t.Fatal("tracked replay was not cancelled")
	}
	select {
	case <-liveDelivered:
	case <-time.After(time.Second):
		t.Fatal("live delivery remained blocked behind replay")
	}

	// Delivery is asynchronous per subscriber: cancellation releases the
	// wedged writer and the queued replay + live frames then flush through
	// the writer goroutine in FIFO order. Wait for all three to land before
	// asserting the order.
	deadline := time.After(2 * time.Second)
	var names []string
	for {
		names = extEventNames(collectExtEventFrames(t, writer.snapshot()))
		if len(names) == 3 {
			break
		}
		select {
		case <-time.After(5 * time.Millisecond):
		case <-deadline:
			t.Fatalf("delivered event order = %v, want replay task, replay dag, then live heartbeat", names)
		}
	}
	if !reflect.DeepEqual(names, []string{"omo.task.updated", "omo.dag.updated", "omo.dag.heartbeat"}) {
		t.Fatalf("delivered event order = %v, want replay task, replay dag, then live heartbeat", names)
	}
}

func TestExtensionEventTransientActivityNotReplayedOnAttach(t *testing.T) {
	writer := newCollectWriter()
	s := newTestSession("chat-ext-transient", writer)

	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.task.updated","data":{"task":{"id":"t1"}}}`)
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.dag.activity","data":{"beat":1}}`)
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.dag.heartbeat","data":{"at":"now"}}`)
	if got := countFramesOfType(writer.snapshot(), "extensionEvent"); got != 3 {
		t.Fatalf("live extensionEvent frames = %d, want 3 (all forwarded); frames: %s", got, writer.typesString())
	}

	late := newCollectWriter()
	s.Attach(late)
	if names := extEventNames(collectExtEventFrames(t, late.snapshot())); !reflect.DeepEqual(names, []string{"omo.task.updated"}) {
		t.Fatalf("replayed extensionEvent names = %v, want exactly [omo.task.updated]: transient events must never replay", names)
	}
}

// A snapshot payload over the cache cap forwards live but is never cached:
// a late subscriber receives no replay of it.
func TestExtensionEventOversizedSnapshotForwardedNotCached(t *testing.T) {
	writer := newCollectWriter()
	s := newTestSession("chat-ext-oversize", writer)

	big := `{"task":{"pad":"` + strings.Repeat("a", 64<<10+1024) + `"}}`
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.task.updated","data":`+big+`}`)
	live := collectExtEventFrames(t, writer.snapshot())
	if len(live) != 1 || live[0].Name != "omo.task.updated" {
		t.Fatalf("oversized event must still forward live; got frames: %s", writer.typesString())
	}
	if string(live[0].Data) != big {
		t.Fatalf("oversized payload forwarded = %d bytes, want verbatim %d bytes", len(live[0].Data), len(big))
	}

	late := newCollectWriter()
	s.Attach(late)
	if replayed := collectExtEventFrames(t, late.snapshot()); len(replayed) != 0 {
		t.Fatalf("oversized snapshot replayed %d frames, want 0; frames: %s", len(replayed), late.typesString())
	}
}

// StartSession must advertise the extension_events capability to the provider
// through SENPI_RPC_CLIENT_CAPABILITIES: injected when absent, comma-merged
// when preset, never duplicated. The fake provider reports the variable it
// actually received by smuggling it through a commands_changed frame (the one
// unsolicited frame type the session forwards on its own).
func TestStartSessionInjectsExtensionEventsCapability(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	script := filepath.Join(t.TempDir(), "env-dump.mjs")
	source := "process.stdout.write(JSON.stringify({type:'commands_changed',commands:[{name:process.env.SENPI_RPC_CLIENT_CAPABILITIES??'',description:'env dump',source:'extension',syntax:'slash'}]})+'\\n');\nsetInterval(()=>{},1000);\n"
	if err := os.WriteFile(script, []byte(source), 0o755); err != nil {
		t.Fatalf("write env-dump provider: %v", err)
	}

	rawEnv := os.Environ()
	baseEnv := make([]string, 0, len(rawEnv))
	for _, entry := range rawEnv {
		if !strings.HasPrefix(entry, "SENPI_RPC_CLIENT_CAPABILITIES=") {
			baseEnv = append(baseEnv, entry)
		}
	}

	cases := []struct {
		name   string
		preset string
		want   string
	}{
		{name: "absent", preset: "", want: "extension_events"},
		{name: "preset is comma-merged", preset: "alpha,beta", want: "alpha,beta,extension_events"},
		{name: "already present is not duplicated", preset: "alpha,extension_events,beta", want: "alpha,extension_events,beta"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := baseEnv
			if tc.preset != "" {
				env = append(env, "SENPI_RPC_CLIENT_CAPABILITIES="+tc.preset)
			}
			w := newCollectWriter()
			s, err := StartSession(context.Background(), SessionOptions{
				ID:     "chat-cap-" + tc.name,
				Binary: node,
				Args:   []string{script},
				Env:    env,
			})
			if err != nil {
				t.Fatalf("start session: %v", err)
			}
			s.Attach(w)
			t.Cleanup(func() {
				if err := s.Close(); err != nil {
					t.Errorf("close session: %v", err)
				}
			})

			frames := w.waitForType(t, "commands", 5*time.Second)
			var frame CommandsFrame
			for _, f := range frames {
				var env2 struct {
					Type string `json:"type"`
				}
				if json.Unmarshal(f, &env2) == nil && env2.Type == "commands" {
					_ = json.Unmarshal(f, &frame)
				}
			}
			if len(frame.Commands) != 1 {
				t.Fatalf("env-dump provider sent %d commands, want 1; frames: %s", len(frame.Commands), w.typesString())
			}
			if got := frame.Commands[0].Name; got != tc.want {
				t.Fatalf("SENPI_RPC_CLIENT_CAPABILITIES = %q, want %q", got, tc.want)
			}
		})
	}
}
