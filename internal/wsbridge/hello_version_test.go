package wsbridge

import (
	"context"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

func TestHelloReportsLiveServerVersion(t *testing.T) {
	store, err := cursorstore.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	manager := session.NewManager(session.Config{})
	t.Cleanup(func() { _ = manager.CloseAll(context.Background()) })

	version := "startup-version"
	server := httptest.NewServer(New(Config{
		Manager:       manager,
		Store:         store,
		ServerVersion: "startup-version",
		ServerVersionFunc: func() string {
			return version
		},
	}))
	t.Cleanup(server.Close)

	connect := func() *collector {
		t.Helper()
		frames := &collector{notify: make(chan struct{}, 8)}
		conn, _, err := gws.NewClient(frames, &gws.ClientOption{Addr: "ws" + strings.TrimPrefix(server.URL, "http")})
		if err != nil {
			t.Fatal(err)
		}
		go conn.ReadLoop()
		t.Cleanup(func() { _ = conn.WriteClose(1000, nil) })
		return frames
	}

	first := connect().next(t, "hello")
	if got := first["serverVersion"]; got != "startup-version" {
		t.Fatalf("first hello serverVersion = %v, want startup-version", got)
	}

	version = "live-version"
	second := connect().next(t, "hello")
	if got := second["serverVersion"]; got != "live-version" {
		t.Fatalf("second hello serverVersion = %v, want live-version", got)
	}
}

func TestHelloReportsConstantServerVersion(t *testing.T) {
	store, err := cursorstore.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	manager := session.NewManager(session.Config{})
	t.Cleanup(func() { _ = manager.CloseAll(context.Background()) })
	server := httptest.NewServer(New(Config{
		Manager:       manager,
		Store:         store,
		ServerVersion: "constant-version",
	}))
	t.Cleanup(server.Close)

	frames := &collector{notify: make(chan struct{}, 8)}
	conn, _, err := gws.NewClient(frames, &gws.ClientOption{Addr: "ws" + strings.TrimPrefix(server.URL, "http")})
	if err != nil {
		t.Fatal(err)
	}
	go conn.ReadLoop()
	t.Cleanup(func() { _ = conn.WriteClose(1000, nil) })

	hello := frames.next(t, "hello")
	if got := hello["serverVersion"]; got != "constant-version" {
		t.Fatalf("hello serverVersion = %v, want constant-version", got)
	}
}
