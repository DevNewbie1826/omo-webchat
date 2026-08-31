package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"testing"
	"time"
)

func TestSharedProviderDeliversTaggedNoticeEmittedBeforeOpenResponse(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	script := `let b='', next=0;
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
process.stdin.on('data',c=>{b+=c;for(let n=b.indexOf('\n');n>=0;n=b.indexOf('\n')){const line=b.slice(0,n);b=b.slice(n+1);if(!line)continue;const x=JSON.parse(line);
if(x.type==='open_session'){const i=++next, handle='rpc-'+i;send({type:'settings_source_selected',sessionId:handle,source:'session-'+i});send({type:'response',command:'open_session',success:true,id:x.id,sessionId:handle,data:{sessionId:handle,state:{}}});}
else if(x.type==='close_session')send({type:'response',command:'close_session',success:true,id:x.id,sessionId:x.sessionId});
}});`

	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	writerA := newCollectWriter()
	writerB := newCollectWriter()
	opts := SessionOptions{Binary: node, Args: []string{"-e", script, "--"}, Cwd: t.TempDir(), ProviderContext: context.Background()}
	opts.ID = "preopen-a"
	if _, started, _, err := manager.AcquireAttach(context.Background(), opts, writerA); err != nil || !started {
		t.Fatalf("attach session A = started %v, err %v", started, err)
	}
	opts.ID = "preopen-b"
	if _, started, _, err := manager.AcquireAttach(context.Background(), opts, writerB); err != nil || !started {
		t.Fatalf("attach session B = started %v, err %v", started, err)
	}
	writerA.waitForType(t, "notice", time.Second)
	writerB.waitForType(t, "notice", time.Second)

	assertSource := func(writer *collectWriter, want, forbidden string) {
		t.Helper()
		notices := collectNoticeFrames(t, writer.snapshot())
		if len(notices) != 1 {
			t.Fatalf("notice frames = %d, want 1; frames: %s", len(notices), writer.typesString())
		}
		var payload struct {
			Source string `json:"source"`
		}
		if err := json.Unmarshal(notices[0].Payload, &payload); err != nil {
			t.Fatalf("decode notice payload: %v", err)
		}
		if payload.Source != want || payload.Source == forbidden {
			t.Fatalf("notice source = %q, want %q and not %q", payload.Source, want, forbidden)
		}
	}
	assertSource(writerA, "session-1", "session-2")
	assertSource(writerB, "session-2", "session-1")
}

func TestSharedProviderPreOpenEventBufferDropsNewestAtRouteQueueBound(t *testing.T) {
	response := make(chan Event, 1)
	session := newTestSession("bounded", nil)
	provider := &sharedProvider{
		state:    sharedProviderStarted,
		sessions: make(map[string]*sessionRoute),
		pending: map[string]pendingProviderRequest{
			"open": {open: true, session: session, response: response},
		},
		requests: make(map[string]*sessionRoute),
	}
	for i := 0; i < sessionQueueSize+1; i++ {
		raw := json.RawMessage(fmt.Sprintf(`{"type":"settings_source_selected","sessionId":"rpc-bounded","sequence":%d}`, i))
		provider.route(Event{Type: "settings_source_selected", Raw: raw})
	}
	provider.route(Event{Type: "response", Raw: json.RawMessage(`{"type":"response","id":"open","success":true,"sessionId":"rpc-bounded","data":{"sessionId":"rpc-bounded","state":{}}}`)})

	provider.mu.Lock()
	route := provider.sessions["rpc-bounded"]
	provider.mu.Unlock()
	if route == nil {
		t.Fatal("open response did not install a route")
	}
	t.Cleanup(route.cancel)
	if got := len(route.queue); got != sessionQueueSize {
		t.Fatalf("queued pre-open events = %d, want bounded cap %d", got, sessionQueueSize)
	}
	for want := 0; want < sessionQueueSize; want++ {
		delivery := <-route.queue
		var payload struct {
			Sequence int `json:"sequence"`
		}
		if err := json.Unmarshal(delivery.event.Raw, &payload); err != nil {
			t.Fatalf("decode buffered event %d: %v", want, err)
		}
		if payload.Sequence != want {
			t.Fatalf("buffered sequence[%d] = %d; drop-newest policy was not preserved", want, payload.Sequence)
		}
	}
}
