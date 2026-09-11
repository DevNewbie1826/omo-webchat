// Package fileio opens read snapshots that permit atomic replacement by writers.
package fileio

import "os"

// Open is os.Open with delete sharing on Windows. The returned descriptor keeps
// reading the opened object if another process renames or replaces its path.
func Open(path string) (*os.File, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	return shareDelete(f)
}

// OpenRoot preserves os.Root's traversal confinement and pins the opened object
// before adjusting its Windows sharing mode. It never reopens a pathname.
func OpenRoot(root *os.Root, name string) (*os.File, error) {
	f, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	return shareDelete(f)
}
