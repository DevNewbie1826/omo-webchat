//go:build !darwin && !linux && !windows

package omorpc

import (
	"errors"
	"os"
)

func openAndFlockEnsureLock(string) (*os.File, error) {
	return nil, errors.New("advisory ensure locks require darwin or linux")
}
