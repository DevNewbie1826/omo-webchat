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

func TestWebSocketOriginValidation(t *testing.T) {
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
	for _, tc := range []struct {
		name   string
		origin string
		want   int
	}{
		{name: "mismatched origin", origin: "http://attacker.invalid", want: http.StatusForbidden},
		{name: "matching origin", origin: "http://" + address, want: http.StatusSwitchingProtocols},
		{name: "absent origin", want: http.StatusSwitchingProtocols},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status := webSocketHandshakeStatus(t, address, "/api/ws", tc.origin, token)
			if status != tc.want {
				t.Fatalf("upgrade status = %d, want %d", status, tc.want)
			}
		})
	}
}

func webSocketHandshakeStatus(t *testing.T, address, path, origin, token string) int {
	t.Helper()
	conn, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatalf("dialing WebSocket endpoint: %v", err)
	}
	defer func() { _ = conn.Close() }()

	var request strings.Builder
	fmt.Fprintf(&request, "GET %s HTTP/1.1\r\n", path)
	fmt.Fprintf(&request, "Host: %s\r\n", address)
	request.WriteString("Connection: Upgrade\r\n")
	request.WriteString("Upgrade: websocket\r\n")
	request.WriteString("Sec-WebSocket-Version: 13\r\n")
	request.WriteString("Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n")
	fmt.Fprintf(&request, "Cookie: %s=%s\r\n", auth.CookieName, token)
	if origin != "" {
		fmt.Fprintf(&request, "Origin: %s\r\n", origin)
	}
	request.WriteString("\r\n")
	if _, err := io.WriteString(conn, request.String()); err != nil {
		t.Fatalf("writing WebSocket handshake: %v", err)
	}

	response, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatalf("reading WebSocket handshake: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	return response.StatusCode
}
