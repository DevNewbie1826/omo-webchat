//go:build darwin || linux

package omorpc

// peerUnknownAccepted decides whether an unclassifiable peer may count as
// launch-owned evidence for a freshly spawned connection. Unix sockets
// expose the peer credential directly (LOCAL_PEERPID on Darwin, SO_PEERCRED
// on Linux), so peerUnknown only means the lookup raced with peer exit or
// the descriptor stopped being a socket: unknown stays a rejection, and
// ownership requires the positive process-group match.
func peerUnknownAccepted() bool { return false }
