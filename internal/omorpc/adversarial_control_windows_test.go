//go:build windows

package omorpc

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
)

// Only the temporary compiler overlay calls these hooks. Production sources,
// installed dependencies, and shipped binaries never acquire control switches.
var adversarialMode = os.Getenv("OMORPC_ADVERSARIAL_CONTROL")
var adversarialBeforePublish = func(string) error { return nil }
var adversarialSecretCache struct {
	sync.Mutex
	secret []byte
}

func adversarialReadSecret(secret []byte) []byte {
	if adversarialMode != "replacement_secret" {
		return secret
	}
	adversarialSecretCache.Lock()
	defer adversarialSecretCache.Unlock()
	if adversarialSecretCache.secret == nil {
		adversarialSecretCache.secret = bytes.Clone(secret)
	}
	return bytes.Clone(adversarialSecretCache.secret)
}

func adversarialAuth(secret []byte) []byte {
	if adversarialMode == "wrong_secret" {
		return bytes.Repeat([]byte{2}, socketSecretBytes)
	}
	return secret
}

type adversarialPatch struct{ file, old, replacement string }

// Exact, unique source transformations; no broad transport or filesystem mock.
var adversarialPatches = []adversarialPatch{
	{"secret_windows.go", "if len(secret) != socketSecretBytes {", `if len(secret) != socketSecretBytes && adversarialMode != "malformed" {`},
	{"secret_windows.go", "if !trusted(owner) {", `if !trusted(owner) && adversarialMode != "foreign_owner" {`},
	{"secret_windows.go", "if ace.Mask&sensitive != 0 && !trusted(sid) {", `if ace.Mask&sensitive != 0 && !trusted(sid) && adversarialMode != "public_acl" {`},
	{"secret_windows.go", "if info.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DIRECTORY) != 0 || info.NumberOfLinks != 1 {", `if (info.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DIRECTORY) != 0 || info.NumberOfLinks != 1) && adversarialMode != "entry" {`},
	{"secret_windows.go", "if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {", `if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 && adversarialMode != "parent" {`},
	{"secret_windows.go", "if err := windows.MoveFileEx(ptr, target, 0); err != nil {", `if err := adversarialBeforePublish(cfg.SocketPath); err != nil { return errors.Join(err, os.Remove(temp)) }
 flags := uint32(0)
 if adversarialMode == "publication" { flags = windows.MOVEFILE_REPLACE_EXISTING }
 if err := windows.MoveFileEx(ptr, target, flags); err != nil {`},
	{"ensure_peercred_windows.go", "if !user.User.Sid.Equals(current.User.Sid) {", `if !user.User.Sid.Equals(current.User.Sid) && adversarialMode != "foreign_peer" {`},
	{"transport_windows.go", "address, err := pipeAddress(path, secret)", "secret = adversarialReadSecret(secret)\n address, err := pipeAddress(path, secret)"},
	{"transport_windows.go", "n, writeErr := conn.Write(secret)", "n, writeErr := conn.Write(adversarialAuth(secret))"},
	{"ensure.go", "d.stopErr = d.Client.Close()", `if adversarialMode == "shared" && !d.Owned { d.stopErr = adversarialStopShared(d.Client) }
 d.stopErr = errors.Join(d.stopErr, d.Client.Close())`},
	{"ensure.go", "if d.Owned && d.supervisor != nil {", `if d.Owned && d.supervisor != nil && adversarialMode != "owned_release" {`},
	{"ensure_endpoint_windows.go", "\"net\"", "\"net\"\n\"os\""},
	{"ensure_endpoint_windows.go", "func (p *endpointProvenance) cleanupAfterReap(time.Duration) error { return nil }", `func (p *endpointProvenance) cleanupAfterReap(time.Duration) error {
 if adversarialMode == "replacement_endpoint" { return os.Remove(p.path+".secret") }
 return nil
}`},
}

func TestWindowsAdversarialControls(t *testing.T) {
	dir := t.TempDir()
	originals := map[string][]byte{}
	patched := map[string]string{}
	for _, patch := range adversarialPatches {
		if _, ok := originals[patch.file]; !ok {
			data, err := os.ReadFile(patch.file)
			if err != nil {
				t.Fatal(err)
			}
			originals[patch.file] = data
			patched[patch.file] = string(data)
		}
		if strings.Count(patched[patch.file], patch.old) != 1 {
			t.Fatalf("control boundary changed: %s", patch.file)
		}
		patched[patch.file] = strings.Replace(patched[patch.file], patch.old, patch.replacement, 1)
	}
	replacements := map[string]string{}
	for name, data := range patched {
		source, err := filepath.Abs(name)
		if err != nil {
			t.Fatal(err)
		}
		target := filepath.Join(dir, name)
		if err := os.WriteFile(target, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		replacements[source] = target
		t.Logf("CONTROL_SOURCE file=%s original=%x overlay=%x", name, sha256.Sum256(originals[name]), sha256.Sum256([]byte(data)))
	}
	overlay, err := json.Marshal(map[string]any{"Replace": replacements})
	if err != nil {
		t.Fatal(err)
	}
	overlayPath := filepath.Join(dir, "overlay.json")
	if err := os.WriteFile(overlayPath, overlay, 0600); err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(dir, "adversarial.test.exe")
	build := exec.CommandContext(t.Context(), "go", "test", "-c", "-overlay", overlayPath, "-o", exe, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("control build: %v\n%s", err, output)
	}
	cases := []struct{ mode, test, assertion string }{
		{"malformed", "TestWindowsAdversarialFilesystem/malformed", "CONTROL_ASSERT malformed"},
		{"foreign_owner", "TestWindowsAdversarialFilesystem/foreign_owner", "CONTROL_ASSERT foreign_owner"},
		{"public_acl", "TestWindowsAdversarialFilesystem/public_acl", "CONTROL_ASSERT public_acl"},
		{"entry", "TestWindowsAdversarialFilesystem/entry", "CONTROL_ASSERT entry"},
		{"parent", "TestWindowsAdversarialFilesystem/parent", "CONTROL_ASSERT parent"},
		{"publication", "TestWindowsAdversarialPublication", "CONTROL_ASSERT publication"},
		{"foreign_peer", "TestWindowsForeignPrincipalRejectedBeforeSecretWrite", "CONTROL_ASSERT foreign_peer"},
		{"wrong_secret", "TestWindowsWrongHandshakeRejected", "CONTROL_ASSERT wrong_secret"},
		{"replacement_secret", "TestWindowsReconnectReadsReplacementSecret", "CONTROL_ASSERT replacement_secret"},
		{"shared", "TestWindowsAdversarialSharedPreservation", "CONTROL_ASSERT shared"},
		{"owned_release", "TestWindowsAdversarialOwnedRelease", "CONTROL_ASSERT owned_release"},
		{"replacement_endpoint", "TestWindowsOwnedStopPreservesReplacementEndpoint", "CONTROL_ASSERT replacement_endpoint"},
	}
	for _, tc := range cases {
		t.Run(tc.mode, func(t *testing.T) {
			for _, mode := range []string{tc.mode, "restored"} {
				// Anchor each slash-delimited component (Go interprets them separately).
				pattern := "^" + strings.ReplaceAll(tc.test, "/", "$/^") + "$"
				cmd := exec.CommandContext(t.Context(), exe, "-test.run="+pattern, "-test.v", "-test.timeout=25s")
				cmd.Env = append(os.Environ(), "OMORPC_ADVERSARIAL_CONTROL="+mode)
				output, err := cmd.CombinedOutput()
				t.Logf("CONTROL_RESULT control=%s mode=%s exit=%v\n%s", tc.mode, mode, err, output)
				text := string(output)
				if mode == "restored" {
					if err != nil || !strings.Contains(text, "--- PASS: "+strings.Split(tc.test, "/")[0]) {
						t.Fatal("restored assertion did not pass")
					}
				} else {
					var exit *exec.ExitError
					if !errors.As(err, &exit) || exit.ExitCode() != 1 || !strings.Contains(text, tc.assertion) || !strings.Contains(text, "--- FAIL: "+strings.Split(tc.test, "/")[0]) {
						t.Fatal("control failed to fail its exact assertion normally")
					}
					// No setup, panic, or cleanup failure can masquerade as a
					// successful negative control. These are machine sentinels,
					// not pinned product prose.
					diagnostics := regexp.MustCompile(`(?m)\b\w+\.go:\d+: (.*)`).FindAllStringSubmatch(text, -1)
					for _, diagnostic := range diagnostics {
						message := diagnostic[1]
						if !strings.HasPrefix(message, tc.assertion) && !strings.HasPrefix(message, "CONTROL_CLEANUP ") && !strings.HasPrefix(message, "cleanup:") {
							t.Fatalf("unexpected child diagnostic: %s", message)
						}
					}
					if (tc.mode == "malformed" || tc.mode == "entry") && strings.Count(text, tc.assertion) != 3 {
						t.Fatal("control did not fail all three boundary variants")
					}
					if tc.mode == "foreign_peer" && !strings.Contains(text, "disclosed 32 auth bytes") {
						t.Fatal("foreign peer control did not prove real wire disclosure")
					}
				}
				if !strings.Contains(text, "CONTROL_CLEANUP "+strings.Split(tc.test, "/")[0]) {
					t.Fatal("child cleanup receipt missing")
				}
			}
		})
	}
	for name, before := range originals {
		after, err := os.ReadFile(name)
		if err != nil || !bytes.Equal(before, after) {
			t.Fatalf("production source changed: %s", name)
		}
	}
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	t.Log("CONTROL_RESTORED production sources byte-identical; overlay/executable removed; all children joined")
}
