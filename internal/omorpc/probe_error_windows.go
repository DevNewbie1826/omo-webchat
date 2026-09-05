//go:build windows

package omorpc

import (
	"errors"
	"os"
)

func isSpawnableProbeError(err error) bool { return isDialAbsentError(err) }

// Named-pipe missing/path-not-found errors wrap os.ErrNotExist. Busy pipes
// exhaust the bounded dial context; denied access/auth and protocol failures
// must not trigger a second supervisor or replace an existing secret.
func isDialAbsentError(err error) bool { return errors.Is(err, os.ErrNotExist) }
