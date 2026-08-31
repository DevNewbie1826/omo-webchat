//go:build !darwin && !linux

package daemon

import "github.com/DevNewbie1826/omo-webchat/internal/config"

func start(_ *config.Config, _ []string) (int, string, error) {
	return 0, "", ErrUnsupported
}

func stop(_ string) (int, error) {
	return 0, ErrUnsupported
}

func status(_ string) (int, error) {
	return 0, ErrUnsupported
}

func prepareChild(_ string) (*Child, error) {
	return nil, ErrUnsupported
}

func childReady(_ *Child) error { return ErrUnsupported }

func closeChild(_ *Child) error { return ErrUnsupported }
