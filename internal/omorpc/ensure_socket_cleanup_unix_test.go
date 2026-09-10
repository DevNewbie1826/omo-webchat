//go:build darwin || linux

package omorpc

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSocketCleanupWithCachedIdentityAlias(t *testing.T) {
	for _, mode := range []string{"removeOwnedSocket", "cleanupAfterReap", "deadOwnedSocket"} {
		t.Run(mode, func(t *testing.T) {
			dir := shortEnsureTempDir(t)
			socket := filepath.Join(dir, "replacement.sock")
			provenance := newEndpointProvenance(socket)
			first, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
			if err != nil {
				t.Fatal(err)
			}
			if err := first.Close(); err != nil {
				t.Fatal(err)
			}
			replacement, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
			if err != nil {
				t.Fatal(err)
			}
			defer replacement.Close()
			// Simulate recycled device/inode in the ownership cache. The
			// listener and all filesystem operations remain real.
			identity, exists := currentSocketIdentity(socket)
			if !exists {
				t.Fatal("replacement has no socket identity")
			}
			provenance.peers[identity] = peerOwned
			if mode == "deadOwnedSocket" {
				replacement.SetUnlinkOnClose(false)
				if err := replacement.Close(); err != nil {
					t.Fatal(err)
				}
			}
			cfg := EnsureConfig{AgentDir: dir, SocketPath: socket, LockTimeout: testAwaitTimeout, LockRetry: time.Millisecond}
			lock, err := acquireEnsureLock(context.Background(), cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer releaseEnsureLock(lock)

			if mode == "cleanupAfterReap" {
				err = provenance.cleanupAfterReap(testAwaitTimeout)
			} else {
				err = removeOwnedSocket(socket, &identity)
			}
			if err != nil {
				t.Fatal(err)
			}
			if mode == "deadOwnedSocket" {
				if _, err := os.Lstat(socket); !os.IsNotExist(err) {
					t.Fatalf("dead owned socket survived cleanup: %v", err)
				}
				return
			}
			conn, err := net.DialTimeout("unix", socket, testAwaitTimeout)
			if err != nil {
				t.Fatalf("replacement listener unreachable after cached identity alias cleanup: %v", err)
			}
			if err := conn.Close(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
