package api

import "testing"

func requireBindingIncarnation(t *testing.T, frame map[string]any, want string) string {
	t.Helper()
	id, ok := frame["bindingId"].(string)
	if !ok || id == "" || want != "" && id != want {
		t.Fatalf("bindingId = %v, want nonempty %q; frame = %v", frame["bindingId"], want, frame)
	}
	return id
}

func TestBindingIncarnationRESTAndWebSocket(t *testing.T) {
	// Given a real authenticated REST/WS server and an attached chat.
	f := newCountsE2EFixture(t)
	conn, frames := f.connectUnsubscribed()
	defer conn.WriteClose(1000, nil)
	writeActivityE2EFrame(t, conn, map[string]any{"type": "chat.create", "wsId": f.storeWorkspaceID(), "chatId": f.chat.ID})
	id := requireBindingIncarnation(t, frames.next(t, "ready"), "")
	requireBindingIncarnation(t, frames.next(t, "chat.todo"), id)
	s, ok := f.manager.Get(f.chat.ID)
	if !ok {
		t.Fatal("chat was not acquired")
	}
	// When live task/DAG events cross both attached and overview transports.
	for _, name := range []string{"omo.task.updated", "omo.dag.updated", "omo.dag.activity"} {
		f.daemon.Emit(map[string]any{
			"type": "extension_event", "sessionId": s.RoutingID(), "name": name,
			"data": map[string]any{"parent_session_id": s.ID(), "tasks": []any{}, "runs": []any{}},
		})
		requireBindingIncarnation(t, frames.next(t, "extensionEvent"), id)
	}
	_, overview := f.connectSubscribe()
	requireBindingIncarnation(t, overview.next(t, "sessions.activity"), id)
	requireBindingIncarnation(t, assertSoleLiveRow(t, f.serverURL, f.token), id)
	// Then reattaching replays the same provider incarnation, rather than
	// inventing another socket-local identity.
	replayConn, replay := f.connectUnsubscribed()
	defer replayConn.WriteClose(1000, nil)
	writeActivityE2EFrame(t, replayConn, map[string]any{"type": "chat.create", "wsId": f.storeWorkspaceID(), "chatId": f.chat.ID})
	requireBindingIncarnation(t, replay.next(t, "ready"), id)
	for range 2 {
		requireBindingIncarnation(t, replay.next(t, "extensionEvent"), id)
	}
	requireBindingIncarnation(t, replay.next(t, "chat.todo"), id)
	writeActivityE2EFrame(t, replayConn, map[string]any{"type": "activity.refresh", "sessionId": f.chat.ID})
	for range 2 {
		requireBindingIncarnation(t, replay.next(t, "extensionEvent"), id)
	}
}

func TestBindingIncarnationSameDurableRebindAnnouncesIdleOverview(t *testing.T) {
	// Given an idle binding observed through both real transports.
	f := newCountsE2EFixture(t)
	conn, frames := f.connectUnsubscribed()
	defer conn.WriteClose(1000, nil)
	writeActivityE2EFrame(t, conn, map[string]any{"type": "chat.create", "wsId": f.storeWorkspaceID(), "chatId": f.chat.ID})
	first := frames.next(t, "ready")
	id := requireBindingIncarnation(t, first, "")
	_, overview := f.connectSubscribe()
	requireBindingIncarnation(t, overview.next(t, "sessions.activity"), id)
	// When the provider binding is stopped and the same durable is reacquired.
	if err := f.manager.Stop(f.chat.ID); err != nil {
		t.Fatal(err)
	}
	rebound, reboundFrames := f.connectUnsubscribed()
	defer rebound.WriteClose(1000, nil)
	writeActivityE2EFrame(t, rebound, map[string]any{"type": "chat.create", "wsId": f.storeWorkspaceID(), "chatId": f.chat.ID})
	second := reboundFrames.next(t, "ready")
	next := requireBindingIncarnation(t, second, "")
	// Then ready, overview, and REST share a new incarnation without activity.
	if next == id || second["piSessionId"] != first["piSessionId"] {
		t.Fatalf("rebind did not preserve durable and change incarnation: %v -> %v", first, second)
	}
	requireBindingIncarnation(t, overview.next(t, "sessions.activity"), next)
	requireBindingIncarnation(t, assertSoleLiveRow(t, f.serverURL, f.token), next)
}

func TestBindingIncarnationOmittedForUnboundOverview(t *testing.T) {
	// Given an unbound durable with no acquired provider route.
	f := newLiveResolveFixture(t)
	frames := f.subscribeExplicit("unbound-incarnation")
	// When engine activity creates a provisional overview row.
	f.emitUnboundTask("unbound-incarnation", 1)
	frame := frames.next(t, "sessions.activity")
	row := assertSoleLiveRow(t, f.serverURL, f.token)
	// Then neither transport invents a binding incarnation.
	for _, value := range []map[string]any{frame, row} {
		if _, exists := value["bindingId"]; exists {
			t.Fatalf("unbound row has bindingId: %v", value)
		}
	}
}
