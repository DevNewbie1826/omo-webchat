//go:build darwin || linux

package omorpc

import (
	"context"
	"net"
)

func dialEndpoint(ctx context.Context, path string) (net.Conn, error) {
	var dialer net.Dialer
	return dialer.DialContext(ctx, "unix", path)
}
