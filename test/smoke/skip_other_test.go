//go:build !windows

package smoke_test

import "testing"

// TestServerSmokeAgainstMockDaemon mirrors the windows-only smoke's name so
// `go test ./test/smoke/` reports a clean skip instead of a package error on
// platforms without the AF_UNIX-on-Windows evidence target.
func TestServerSmokeAgainstMockDaemon(t *testing.T) {
	t.Skip("windows-only smoke: boots the real server against a mock omo daemon on an AF_UNIX socket")
}
