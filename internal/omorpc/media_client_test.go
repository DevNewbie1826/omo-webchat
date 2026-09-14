package omorpc_test

// Client-side contract tests for the get_media command against the shared
// mock daemon: the exact wire request shape, decoding of the returned media
// block, and the media_not_found failure surface.

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func newMediaDaemon(t *testing.T) *omorpctest.Daemon {
	t.Helper()
	// macOS caps unix socket paths at 104 bytes; use a short temp dir for
	// the socket and register cleanup with the test.
	dir, err := os.MkdirTemp("", "omorpc-md-*")
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	d := omorpctest.New(dir)
	if err := d.Start(); err != nil {
		t.Fatalf("start daemon: %v", err)
	}
	t.Cleanup(d.Stop)
	return d
}

func dialMediaClient(t *testing.T, d *omorpctest.Daemon) *omorpc.Client {
	t.Helper()
	c, err := omorpc.Dial(context.Background(), d.SocketPath())
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func openMediaSession(t *testing.T, c *omorpc.Client) omorpc.OpenSessionData {
	t.Helper()
	resp, err := c.Call(context.Background(), omorpc.OpenSession{CWD: t.TempDir()})
	if err != nil {
		t.Fatalf("open_session: %v", err)
	}
	if !resp.Success {
		t.Fatalf("open_session: %v", resp.Err())
	}
	var opened omorpc.OpenSessionData
	if err := json.Unmarshal(resp.Data, &opened); err != nil {
		t.Fatalf("decode open_session data: %v", err)
	}
	return opened
}

// TestClientGetMediaRequestShapeAndDecode pins (a) the exact get_media wire
// request and (b) the decoded media block: the request carries exactly
// id/type/sessionId/toolCallId/contentIndex, and the typed data payload
// exposes the fetched image block.
func TestClientGetMediaRequestShapeAndDecode(t *testing.T) {
	d := newMediaDaemon(t)
	c := dialMediaClient(t, d)
	opened := openMediaSession(t, c)

	d.SetSessionMedia(opened.State.SessionFile, "tool-9", 1, map[string]any{
		"type": "image", "data": "aGVsbG8=", "mimeType": "image/png",
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	data, err := c.GetMedia(ctx, opened.SessionID, "tool-9", 1)
	if err != nil {
		t.Fatalf("GetMedia: %v", err)
	}
	if data.ToolCallID != "tool-9" || data.ContentIndex != 1 {
		t.Fatalf("GetMedia echo = (%q, %d), want (tool-9, 1)", data.ToolCallID, data.ContentIndex)
	}
	if data.Content.Type != "image" || data.Content.MimeType != "image/png" || data.Content.Data != "aGVsbG8=" {
		t.Fatalf("GetMedia content = %+v, want the armed image block", data.Content)
	}

	request := d.LastRequest(omorpc.CmdGetMedia)
	if request == nil {
		t.Fatal("daemon never received get_media")
	}
	if len(request) != 5 {
		t.Fatalf("get_media request keys = %v, want exactly id/type/sessionId/toolCallId/contentIndex", request)
	}
	if got, _ := request["type"].(string); got != "get_media" {
		t.Errorf("type = %q, want get_media", got)
	}
	if got, _ := request["toolCallId"].(string); got != "tool-9" {
		t.Errorf("toolCallId = %q, want tool-9", got)
	}
	if got, ok := request["contentIndex"].(float64); !ok || got != 1 {
		t.Errorf("contentIndex = %v, want 1", request["contentIndex"])
	}
	if got, _ := request["sessionId"].(string); got != opened.SessionID {
		t.Errorf("sessionId = %q, want routing handle %q", got, opened.SessionID)
	}
	if _, ok := request["id"].(string); !ok {
		t.Errorf("get_media request carries no correlation id: %v", request)
	}
}

// TestClientGetMediaContentIndexZeroSerializes pins that a zero contentIndex
// still travels on the wire: the placeholder ref is positional, and an omitted
// index would change which block the engine resolves.
func TestClientGetMediaContentIndexZeroSerializes(t *testing.T) {
	d := newMediaDaemon(t)
	c := dialMediaClient(t, d)
	opened := openMediaSession(t, c)

	d.SetSessionMedia(opened.State.SessionFile, "tool-0", 0, map[string]any{
		"type": "image", "data": "aGk=", "mimeType": "image/jpeg",
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	data, err := c.GetMedia(ctx, opened.SessionID, "tool-0", 0)
	if err != nil {
		t.Fatalf("GetMedia: %v", err)
	}
	if data.ContentIndex != 0 || data.Content.Data != "aGk=" {
		t.Fatalf("GetMedia = %+v, want contentIndex 0 with the armed block", data)
	}
	request := d.LastRequest(omorpc.CmdGetMedia)
	if _, ok := request["contentIndex"].(float64); !ok {
		t.Fatalf("contentIndex missing from zero-index request: %v", request)
	}
}

// TestClientGetMediaNotFound pins the failure surface: coordinates that do
// not resolve to a media block surface as an error whose stable code is
// media_not_found.
func TestClientGetMediaNotFound(t *testing.T) {
	d := newMediaDaemon(t)
	c := dialMediaClient(t, d)
	opened := openMediaSession(t, c)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	data, err := c.GetMedia(ctx, opened.SessionID, "unknown-tool", 3)
	if err == nil {
		t.Fatalf("GetMedia(unarmed coordinates) = %+v, want an error", data)
	}
	var stable *omorpc.StableError
	if !errors.As(err, &stable) || stable.Code != omorpc.ErrCodeMediaNotFound {
		t.Fatalf("GetMedia error = %v, want stable code %s", err, omorpc.ErrCodeMediaNotFound)
	}
}
