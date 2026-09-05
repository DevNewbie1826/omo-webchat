//go:build darwin || linux

package omorpc

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/fileid"
)

func prepareEndpoint(EnsureConfig) error { return nil }

func currentSocketIdentity(path string) (socketIdentity, bool) {
	return fileid.FromPath(path)
}

// cleanupAfterReap is the only path that promotes an unacknowledged endpoint
// to owned. Once the complete launch process group is gone, a stable refusal
// proves that a novel pathname is launch debris rather than a live peer.
func (p *endpointProvenance) cleanupAfterReap(timeout time.Duration) error {
	identity, exists := currentSocketIdentity(p.path)
	if !exists {
		return nil
	}
	if p.provenance(identity) != peerForeign && (!p.baselineExists || identity != p.baseline) {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		var dialer net.Dialer
		conn, err := dialer.DialContext(ctx, "unix", p.path)
		if conn != nil {
			_ = conn.Close()
			p.peers[identity] = peerForeign
		} else if after, stable := currentSocketIdentity(p.path); stable && after == identity && isSpawnableProbeError(err) {
			p.peers[identity] = peerOwned
		}
	}
	if !p.owns(identity) {
		return nil
	}
	return removeOwnedSocket(p.path, &identity)
}

// probeAuthenticatedDaemon binds peer authentication to the pathname inode:
// the path must name the same socket immediately before and after the dial.
// A replacement after the first readiness handshake therefore cannot lend its
// inode to the old authenticated connection.
func probeAuthenticatedDaemon(ctx context.Context, cfg EnsureConfig, processGroup int) (*Client, socketIdentity, bool, peerProvenance, error) {
	before, exists := currentSocketIdentity(cfg.SocketPath)
	if !exists {
		return nil, socketIdentity{}, false, peerUnknown, os.ErrNotExist
	}
	client, err := probeDaemon(ctx, cfg)
	if err != nil {
		return nil, socketIdentity{}, false, peerUnknown, err
	}
	after, exists := currentSocketIdentity(cfg.SocketPath)
	stable := exists && before == after
	if !stable {
		return client, before, false, peerUnknown, nil
	}
	return client, before, true, clientPeerProvenance(client, processGroup), nil
}

func authenticateSocketPathWithPeerPID(ctx context.Context, path string, processGroup int, peerPID func(net.Conn) (int, error)) (socketIdentity, bool, peerProvenance, error) {
	before, exists := currentSocketIdentity(path)
	if !exists {
		return socketIdentity{}, false, peerUnknown, os.ErrNotExist
	}
	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "unix", path)
	if err != nil {
		after, stillExists := currentSocketIdentity(path)
		return before, stillExists && before == after, peerUnknown, err
	}
	defer conn.Close()
	after, exists := currentSocketIdentity(path)
	stable := exists && before == after
	if !stable {
		return before, false, peerUnknown, nil
	}
	peer, peerErr := peerPID(conn)
	return before, true, classifyPeerProvenance(peer, peerErr, processGroup), peerErr
}

func connectionPeerProvenance(conn net.Conn, processGroup int) peerProvenance {
	pid, err := connectionPeerPID(conn)
	return classifyPeerProvenance(pid, err, processGroup)
}

// removeOwnedSocket runs while EnsureDaemon holds the endpoint lock. The
// identity comparison prevents cleanup from unlinking an endpoint that
// replaced the one observed during this attempt.
func removeOwnedSocket(path string, owned *socketIdentity) error {
	if owned == nil {
		return nil
	}
	current, exists := currentSocketIdentity(path)
	if !exists || current != *owned {
		return nil
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("omorpc: remove failed daemon socket: %w", err)
	}
	return nil
}
