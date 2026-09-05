//go:build windows

package omorpc

// Named-pipe server identity is available through supported Win32 APIs.
func peerUnknownAccepted() bool { return false }
