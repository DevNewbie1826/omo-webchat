//go:build !(darwin || linux)

package omorpc

import "context"

// RetireUnownedEngine is unsupported off Unix; restart keeps refusing.
func RetireUnownedEngine(context.Context, EnsureConfig) error { return ErrDaemonNotOwned }
