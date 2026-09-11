//go:build !windows

package fileio

import "os"

func shareDelete(f *os.File) (*os.File, error) { return f, nil }
