//go:build darwin || linux

package fileid

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFromInfoIdentityStableAcrossTwoStats(t *testing.T) {
	t.Parallel()
	// Given
	path := filepath.Join(t.TempDir(), "a")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	// When
	first, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	id1, ok1 := FromInfo(first)
	second, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	id2, ok2 := FromInfo(second)

	// Then
	if !ok1 || !ok2 {
		t.Fatalf("FromInfo ok1=%v ok2=%v", ok1, ok2)
	}
	if id1.Inode == 0 {
		t.Fatalf("zero inode: %+v", id1)
	}
	if id1 != id2 {
		t.Fatalf("identity changed across stats: %+v vs %+v", id1, id2)
	}
}

func TestFromInfoDistinctFilesYieldDistinctIdentities(t *testing.T) {
	t.Parallel()
	// Given
	dir := t.TempDir()
	pathA := filepath.Join(dir, "a")
	pathB := filepath.Join(dir, "b")
	if err := os.WriteFile(pathA, []byte("a"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pathB, []byte("b"), 0o600); err != nil {
		t.Fatal(err)
	}

	// When
	infoA, err := os.Lstat(pathA)
	if err != nil {
		t.Fatal(err)
	}
	infoB, err := os.Lstat(pathB)
	if err != nil {
		t.Fatal(err)
	}
	idA, okA := FromInfo(infoA)
	idB, okB := FromInfo(infoB)

	// Then
	if !okA || !okB {
		t.Fatalf("FromInfo okA=%v okB=%v", okA, okB)
	}
	if idA == idB {
		t.Fatalf("distinct files shared identity %+v", idA)
	}
}
