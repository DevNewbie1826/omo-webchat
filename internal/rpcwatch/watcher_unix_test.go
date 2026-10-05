//go:build darwin || linux

package rpcwatch

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func TestWatcherUnixSocketObservesOriginalWithoutOpening(t *testing.T) {
	dir, err := os.MkdirTemp("", "enrollment-watch-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(dir); err != nil {
			t.Error(err)
		}
	})
	d := omorpctest.New(dir)
	if err := d.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Stop)
	client, err := omorpc.Dial(t.Context(), d.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close() })
	resp, err := client.Call(t.Context(), omorpc.OpenSession{CWD: "/watched"})
	if err != nil {
		t.Fatal(err)
	}
	var opened omorpc.OpenSessionData
	if err := json.Unmarshal(resp.Data, &opened); err != nil {
		t.Fatal(err)
	}
	before := d.RequestCount(omorpc.CmdOpenSession)
	w := New(client)
	w.Tick(t.Context())
	rows := w.Sessions()
	if len(rows) != 1 || rows[0].SessionID != opened.SessionID || rows[0].DurableSessionID != opened.State.SessionID || rows[0].SessionPath != opened.State.SessionFile {
		t.Fatalf("socket snapshot = %+v", rows)
	}
	if delta := d.RequestCount(omorpc.CmdOpenSession) - before; delta != 0 {
		t.Fatalf("watcher opened %d sessions", delta)
	}
	if _, err := client.Call(t.Context(), omorpc.CloseSession{SessionID: opened.SessionID}); err != nil {
		t.Fatal(err)
	}
	w.Tick(t.Context())
	if len(w.Sessions()) != 0 {
		t.Fatal("closed socket session remained live")
	}
}
