//go:build windows

package omorpc

import (
	"errors"
	"net"
)

// Windows peer-PID verification is unavailable in this phase: the unix
// LOCAL_PEERPID / SO_PEERCRED getsockopt credentials have no documented Win32
// equivalent. Provenance classification therefore stays peerUnknown, and the
// connection remains guarded by socket identity plus the protocol probe.
func connectionPeerPID(net.Conn) (int, error) {
	return 0, errors.New("peer pid lookup is unavailable on windows")
}

func classifyPeerProvenance(int, error, int) peerProvenance {
	return peerUnknown
}
