//go:build windows

package omorpc

import (
	"context"
	"net"
	"time"
)

// Named-pipe instances have kernel lifetimes, not removable filesystem nodes.
// The secret is deliberately retained, including after an owned process exits.
func currentSocketIdentity(string) (socketIdentity, bool)          { return socketIdentity{}, false }
func (p *endpointProvenance) cleanupAfterReap(time.Duration) error { return nil }
func removeOwnedSocket(string, *socketIdentity) error              { return nil }

func probeAuthenticatedDaemon(ctx context.Context, cfg EnsureConfig, supervisorPID int) (*Client, socketIdentity, bool, peerProvenance, error) {
	client, err := probeDaemon(ctx, cfg)
	if err != nil {
		return nil, socketIdentity{}, false, peerUnknown, err
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if client.current == nil {
		return client, socketIdentity{}, false, peerUnknown, ErrDisconnected
	}
	pipe := client.current.conn.(*identifiedPipe)
	return client, pipe.identity, true, connectionPeerProvenance(pipe, supervisorPID), nil
}

func authenticateSocketPathWithPeerPID(ctx context.Context, path string, supervisorPID int, peerPID func(net.Conn) (int, error)) (identity socketIdentity, stable bool, peer peerProvenance, resultErr error) {
	conn, err := dialEndpoint(ctx, path)
	if err != nil {
		return socketIdentity{}, false, peerUnknown, err
	}
	defer func() {
		if err := conn.Close(); resultErr == nil {
			resultErr = err
		}
	}()
	pipe := conn.(*identifiedPipe)
	pid, err := peerPID(conn)
	if err != nil || pid != int(pipe.pid) {
		return pipe.identity, false, peerUnknown, err
	}
	return pipe.identity, true, connectionPeerProvenance(conn, supervisorPID), nil
}
