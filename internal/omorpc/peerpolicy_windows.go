//go:build windows

package omorpc

// peerUnknownAccepted decides whether an unclassifiable peer may count as
// launch-owned evidence for a freshly spawned connection. Windows exposes no
// peer-PID credential for a connected socket (no LOCAL_PEERPID / SO_PEERCRED
// equivalent), so every classification is peerUnknown by construction and
// rejection would make spawning impossible; the launch guards there are the
// fileid socket-identity stability check plus the protocol capability probe.
func peerUnknownAccepted() bool { return true }
