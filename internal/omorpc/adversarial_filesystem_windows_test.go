//go:build windows

package omorpc

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func controlCleanupReceipt(t *testing.T) {
	t.Helper()
	// Registered before fixtures so this runs after their checked cleanups.
	t.Cleanup(func() { t.Log("CONTROL_CLEANUP " + t.Name()) })
}

func TestWindowsAdversarialFilesystem(t *testing.T) {
	controlCleanupReceipt(t)
	for _, name := range []string{"malformed", "foreign_owner", "public_acl", "entry", "parent"} {
		t.Run(name, func(t *testing.T) {
			cfg := pipeEnsureConfig(t)
			if err := prepareEndpoint(t.Context(), cfg); err != nil {
				t.Fatal(err)
			}
			path := cfg.SocketPath + ".secret"
			switch name {
			case "malformed":
				for _, size := range []int{0, 31, 33} {
					t.Run(strconv.Itoa(size), func(t *testing.T) {
						before := bytes.Repeat([]byte{0x41}, size)
						if err := os.WriteFile(path, before, 0600); err != nil {
							t.Fatal(err)
						}
						_, err := readEndpointSecret(t.Context(), cfg.SocketPath)
						after, readErr := os.ReadFile(path)
						if readErr != nil || !bytes.Equal(before, after) {
							t.Fatal("malformed fixture contents changed")
						}
						if !errors.Is(err, os.ErrPermission) {
							t.Errorf("CONTROL_ASSERT malformed size=%d permission=%t", size, errors.Is(err, os.ErrPermission))
						}
					})
				}
				return
			case "foreign_owner":
				foreign, err := windows.SecurityDescriptorFromString("O:BUD:P(A;;FA;;;SY)(A;;FA;;;BA)")
				if err != nil {
					t.Fatal(err)
				}
				original := secretSecurityInfo
				t.Cleanup(func() { secretSecurityInfo = original })
				// Narrow metadata injection only; still query the real open file first.
				secretSecurityInfo = func(h windows.Handle, k windows.SE_OBJECT_TYPE, i windows.SECURITY_INFORMATION) (*windows.SECURITY_DESCRIPTOR, error) {
					if _, err := original(h, k, i); err != nil {
						return nil, err
					}
					return foreign, nil
				}
			case "public_acl":
				sd, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;WD)")
				if err != nil {
					t.Fatal(err)
				}
				acl, _, err := sd.DACL()
				if err != nil {
					t.Fatal(err)
				}
				if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
					t.Fatal(err)
				}
			case "entry":
				for _, kind := range []string{"directory", "junction", "hardlink"} {
					t.Run(kind, func(t *testing.T) {
						entry := filepath.Join(filepath.Dir(path), kind)
						switch kind {
						case "directory":
							if err := os.Mkdir(entry, 0700); err != nil {
								t.Fatal(err)
							}
						case "junction":
							if out, err := exec.CommandContext(t.Context(), "cmd", "/c", "mklink", "/J", entry, filepath.Dir(path)).CombinedOutput(); err != nil {
								t.Fatalf("junction: %v %s", err, out)
							}
						case "hardlink":
							if err := os.Link(path, entry); err != nil {
								t.Fatal(err)
							}
						}
						t.Cleanup(func() {
							if err := os.Remove(entry); err != nil {
								t.Error(err)
							}
						})
						ptr, err := windows.UTF16PtrFromString(entry)
						if err != nil {
							t.Fatal(err)
						}
						h, err := windows.CreateFile(ptr, windows.GENERIC_READ|windows.READ_CONTROL, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
						if err != nil {
							t.Fatal(err)
						}
						err = validateSecretHandle(h)
						if closeErr := windows.CloseHandle(h); closeErr != nil {
							t.Fatal(closeErr)
						}
						if !errors.Is(err, os.ErrPermission) {
							t.Errorf("CONTROL_ASSERT entry kind=%s permission=%t", kind, errors.Is(err, os.ErrPermission))
						}
					})
				}
				return
			case "parent":
				link := filepath.Join(filepath.Dir(path), "parent")
				if out, err := exec.CommandContext(t.Context(), "cmd", "/c", "mklink", "/J", link, filepath.Dir(path)).CombinedOutput(); err != nil {
					t.Fatalf("junction: %v %s", err, out)
				}
				t.Cleanup(func() {
					if err := os.Remove(link); err != nil {
						t.Error(err)
					}
				})
				release, err := pinSecretParents(t.Context(), filepath.Join(link, "rpc.sock"))
				if release != nil {
					if closeErr := release(); closeErr != nil {
						t.Fatal(closeErr)
					}
				}
				if !errors.Is(err, os.ErrPermission) {
					t.Errorf("CONTROL_ASSERT parent permission=%t", errors.Is(err, os.ErrPermission))
				}
				return
			}
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			_, err = readEndpointSecret(t.Context(), cfg.SocketPath)
			after, readErr := os.ReadFile(path)
			if readErr != nil || !bytes.Equal(before, after) {
				t.Fatal("rejected secret contents changed")
			}
			if !errors.Is(err, os.ErrPermission) {
				t.Errorf("CONTROL_ASSERT %s permission=%t", name, errors.Is(err, os.ErrPermission))
			}
		})
	}
}

func TestWindowsAdversarialPublication(t *testing.T) {
	controlCleanupReceipt(t)
	cfg := pipeEnsureConfig(t)
	competitor := pipeEnsureConfig(t)
	if err := prepareEndpoint(t.Context(), competitor); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(competitor.SocketPath + ".secret")
	if err != nil {
		t.Fatal(err)
	}
	old := adversarialBeforePublish
	t.Cleanup(func() { adversarialBeforePublish = old })
	published := false
	adversarialBeforePublish = func(path string) error {
		published = true
		return os.Rename(competitor.SocketPath+".secret", path+".secret")
	}
	// The overlay observes immediately before the real atomic MoveFileEx. In
	// ordinary (non-overlay) suites use the already-published winner instead.
	if adversarialMode == "" {
		if err := adversarialBeforePublish(cfg.SocketPath); err != nil {
			t.Fatal(err)
		}
	}
	if err := prepareEndpoint(t.Context(), cfg); err != nil {
		t.Fatal(err)
	}
	if !published {
		t.Fatal("competing publisher boundary was not reached")
	}
	after, err := readEndpointSecret(t.Context(), cfg.SocketPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Error("CONTROL_ASSERT publication existing winner replaced")
	}
	entries, err := filepath.Glob(filepath.Join(cfg.StateDir, ".rpc-secret-*"))
	if err != nil || len(entries) != 0 {
		t.Fatal("publication temporary file leaked")
	}
}

// Called only by the test compiler overlay at the shared Stop ownership guard.
// The retained pipe identity names the isolated helper, never a PATH daemon.
func adversarialStopShared(c *Client) error {
	c.mu.Lock()
	pid := c.current.conn.(*identifiedPipe).pid
	c.mu.Unlock()
	h, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, pid)
	if err != nil {
		return err
	}
	terminateErr := windows.TerminateProcess(h, 1)
	state, waitErr := windows.WaitForSingleObject(h, 5000)
	if waitErr == nil && state != windows.WAIT_OBJECT_0 {
		waitErr = errors.New("shared control process did not join")
	}
	return errors.Join(terminateErr, waitErr, windows.CloseHandle(h))
}

func TestWindowsAdversarialSharedPreservation(t *testing.T) {
	controlCleanupReceipt(t)
	cfg := pipeEnsureConfig(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	owner, err := EnsureDaemon(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := owner.StopBounded(5 * time.Second); err != nil {
			t.Error(err)
		}
	})
	before, err := os.ReadFile(cfg.SocketPath + ".secret")
	if err != nil {
		t.Fatal(err)
	}
	shared, err := EnsureDaemon(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if shared.Owned {
		t.Fatal("shared ownership claimed")
	}
	if err := shared.StopBounded(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(cfg.SocketPath + ".secret")
	if err != nil || !bytes.Equal(before, after) {
		t.Error("CONTROL_ASSERT shared endpoint credentials damaged")
	}
	if _, err := owner.Client.Call(ctx, GetProtocolInfo{}); err != nil {
		t.Errorf("CONTROL_ASSERT shared live owner damaged: %v", err)
	}
}

func TestWindowsAdversarialOwnedRelease(t *testing.T) {
	controlCleanupReceipt(t)
	cfg := pipeEnsureConfig(t)
	owner, err := EnsureDaemon(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if !owner.Owned {
		t.Fatal("fresh helper unowned")
	}
	// Retain the real native server handle before Stop closes the client's copy.
	owner.Client.mu.Lock()
	pid := owner.Client.current.conn.(*identifiedPipe).pid
	owner.Client.mu.Unlock()
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, pid)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		// Bypass Stop's once only for cleanup of the deliberately disabled branch.
		if adversarialMode == "owned_release" {
			if err := stopOwnedSupervisor(context.Background(), owner.supervisor, owner.waitCh); err != nil {
				t.Error(err)
			}
		}
		state, waitErr := windows.WaitForSingleObject(h, 0)
		if waitErr != nil || state != windows.WAIT_OBJECT_0 {
			t.Errorf("owned control cleanup did not join: state=%d error=%v", state, waitErr)
		}
		if err := windows.CloseHandle(h); err != nil {
			t.Error(err)
		}
	})
	if err := owner.StopBounded(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	state, err := windows.WaitForSingleObject(h, 0)
	if err != nil {
		t.Fatal(err)
	}
	if state != windows.WAIT_OBJECT_0 {
		t.Error("CONTROL_ASSERT owned_release Stop returned with live owned process")
	}
}
