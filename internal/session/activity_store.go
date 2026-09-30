package session

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

var (
	ErrActivityStoreAbsent       = errors.New("activity store does not exist")
	ErrActivityStoreInaccessible = errors.New("activity store is inaccessible")
)

type activityStoreLocation struct {
	anchor     string
	components []string
	legacy     bool
}

// resolveActivityStore mirrors OmO's legacy-first project-state naming. The
// external anchor comes only from server environment, never from client input.
func resolveActivityStore(cwd string) (activityStoreLocation, error) {
	absolute, err := filepath.Abs(cwd)
	if err != nil {
		return activityStoreLocation{}, ErrActivityStoreInaccessible
	}
	legacy := filepath.Join(absolute, ".omo", "senpi-task")
	if _, err := os.Stat(legacy); err == nil {
		return activityStoreLocation{absolute, []string{".omo", "senpi-task"}, true}, nil
	} else if !isAbsentPathError(err) {
		return activityStoreLocation{}, ErrActivityStoreInaccessible
	}
	canonical, err := filepath.EvalSymlinks(absolute)
	if isAbsentPathError(err) {
		canonical = absolute
	} else if err != nil {
		return activityStoreLocation{}, ErrActivityStoreInaccessible
	}
	name := filepath.Base(canonical)
	if filepath.Dir(canonical) == canonical {
		name = ""
	}
	name = strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsNumber(r) || strings.ContainsRune("._-", r) {
			return r
		}
		return '_'
	}, name)
	if name == "" {
		name = "root"
	}
	sum := sha256.Sum256([]byte(canonical))
	project := name + "-" + hex.EncodeToString(sum[:])[:12]
	agentDir := CodingAgentDir()
	if agentDir == "" {
		return activityStoreLocation{}, ErrActivityStoreInaccessible
	}
	return activityStoreLocation{agentDir, []string{"projects", project, "senpi-task"}, false}, nil
}

// OpenActivityDirectory pins each selected store component before walking
// children. No descendant may be a symlink; os.Root confines the lstat/open
// race, and identity checks reject replacement. The configured agent directory
// itself is the trusted anchor, just as cwd is for the legacy store.
func OpenActivityDirectory(cwd string, children ...string) (*os.Root, error) {
	location, err := resolveActivityStore(cwd)
	if err != nil {
		return nil, err
	}
	return location.open(children...)
}

func (location activityStoreLocation) open(children ...string) (*os.Root, error) {
	root, err := os.OpenRoot(location.anchor)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrActivityStoreAbsent
	}
	if err != nil {
		return nil, ErrActivityStoreInaccessible
	}
	return walkActivityDirectory(root, append(location.components, children...)...)
}

func openActivityChildren(store *os.Root, children ...string) (*os.Root, error) {
	root, err := store.OpenRoot(".")
	if err != nil {
		return nil, ErrActivityStoreInaccessible
	}
	return walkActivityDirectory(root, children...)
}

// walkActivityDirectory takes ownership of root, closing replaced descriptors.
func walkActivityDirectory(root *os.Root, components ...string) (*os.Root, error) {
	for _, component := range components {
		before, err := root.Lstat(component)
		if errors.Is(err, os.ErrNotExist) {
			root.Close()
			return nil, ErrActivityStoreAbsent
		}
		if err != nil || !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
			root.Close()
			return nil, ErrActivityStoreInaccessible
		}
		next, err := root.OpenRoot(component)
		root.Close()
		if err != nil {
			return nil, ErrActivityStoreInaccessible
		}
		after, err := next.Stat(".")
		if err != nil || !os.SameFile(before, after) {
			next.Close()
			return nil, ErrActivityStoreInaccessible
		}
		root = next
	}
	return root, nil
}
