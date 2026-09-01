package api

import (
	"bufio"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
)

func TestWebSocketNegotiatesPermessageDeflate(t *testing.T) {
	ctx := t.Context()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	sessions := auth.NewSessionStore(ctx, "password", logger)
	token, err := sessions.Create(ctx)
	if err != nil {
		t.Fatalf("creating session: %v", err)
	}
	server := httptest.NewServer(New(ctx, &config.Config{}, nil, sessions, logger).Handler())
	defer server.Close()
	defer server.CloseClientConnections()

	address := strings.TrimPrefix(server.URL, "http://")
	conn, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatalf("dialing WebSocket endpoint: %v", err)
	}
	defer func() { _ = conn.Close() }()

	var request strings.Builder
	fmt.Fprintf(&request, "GET /api/ws HTTP/1.1\r\n")
	fmt.Fprintf(&request, "Host: %s\r\n", address)
	request.WriteString("Connection: Upgrade\r\n")
	request.WriteString("Upgrade: websocket\r\n")
	request.WriteString("Sec-WebSocket-Version: 13\r\n")
	request.WriteString("Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n")
	request.WriteString("Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n")
	fmt.Fprintf(&request, "Cookie: %s=%s\r\n", auth.CookieName, token)
	request.WriteString("\r\n")
	if _, err := io.WriteString(conn, request.String()); err != nil {
		t.Fatalf("writing WebSocket handshake: %v", err)
	}

	response, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatalf("reading WebSocket handshake: %v", err)
	}
	defer func() { _ = response.Body.Close() }()

	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("upgrade status = %d, want %d", response.StatusCode, http.StatusSwitchingProtocols)
	}
	extensions := response.Header.Get("Sec-WebSocket-Extensions")
	if !strings.Contains(extensions, "permessage-deflate") {
		t.Fatalf("Sec-WebSocket-Extensions = %q, want substring %q", extensions, "permessage-deflate")
	}
}
