//go:build !windows

// Package transport supplies real platform RPC endpoints for wire fixtures.
package transport

import (
	"context"
	"net"
)

func Listen(path string) (net.Listener, error) { return net.Listen("unix", path) }
func Dial(ctx context.Context, path string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "unix", path)
}
