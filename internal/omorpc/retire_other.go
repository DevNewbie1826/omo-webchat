//go:build !(darwin || linux)

package omorpc

import "context"

// SocketPathFor resolves the endpoint EnsureDaemon would use for cfg.
func SocketPathFor(cfg EnsureConfig) (string, error) {
	cfg, err := normalizeEnsureConfig(cfg)
	if err != nil {
		return "", err
	}
	return cfg.SocketPath, nil
}

// RetireUnownedEngine is unsupported off Unix; restart keeps refusing.
func RetireUnownedEngine(context.Context, string) error { return ErrDaemonNotOwned }
