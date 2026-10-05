package api

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/rpcwatch"
)

func TestEnrollmentRootGateRejectsOutsidePrefixAndSymlink(t *testing.T) {
	for _, kind := range []string{"outside", "prefix-sibling", "symlink-escape", "missing-under-symlink", "inside", "root"} {
		t.Run(kind, func(t *testing.T) {
			// Given: daemon cwd inside root or reaching outside via an alias.
			s, store, caller, ws := enrollmentFixture(t)
			cwd := filepath.Join(ws.Path, "new-project")
			allowed := false
			switch kind {
			case "outside":
				cwd = t.TempDir()
			case "prefix-sibling":
				cwd = ws.Path + "-sibling"
			case "symlink-escape", "missing-under-symlink":
				cwd = filepath.Join(ws.Path, "escape")
				if err := os.Symlink(t.TempDir(), cwd); err != nil {
					t.Fatal(err)
				}
				if kind == "missing-under-symlink" {
					cwd = filepath.Join(cwd, "missing")
				}
			case "inside":
				allowed = true
				if err := os.Mkdir(cwd, 0o700); err != nil {
					t.Fatal(err)
				}
			case "root":
				cwd, allowed = ws.Path, true
			}
			live := observedEnrollment(ws, "root-gated")
			live.Cwd = cwd
			caller.sessions = []rpcwatch.Session{live}
			// When: reconciliation processes two daemon observations.
			s.rpcWatcher.Tick(t.Context())
			s.rpcWatcher.Tick(t.Context())
			// Then: only root-contained sessions produce workspaces and chats.
			workspaces := store.ListWorkspaces()
			if !allowed {
				if len(workspaces) != 1 || len(store.ListChats(ws.ID)) != 0 {
					t.Fatalf("out-of-root enrollment: %+v", workspaces)
				}
				return
			}
			total := 0
			for _, got := range workspaces {
				total += len(store.ListChats(got.ID))
				if got.ID != ws.ID && (got.Name != filepath.Base(cwd) || got.Path != cwd) {
					// macOS /var aliases may normalize through /private.
					canonical, _ := enrollmentPath(cwd)
					if got.Path != canonical || got.Name != filepath.Base(cwd) {
						t.Fatalf("automatic workspace = %+v", got)
					}
				}
			}
			if total != 1 {
				t.Fatalf("root-contained enrollment count = %d", total)
			}
		})
	}
}

func TestEnrollmentFromEmptyStoreCreatesWorkspaceAndChat(t *testing.T) {
	// Given: no workspaces or attached/live targets at all.
	s, store, caller, ws := enrollmentFixture(t)
	if err := store.DeleteWorkspace(ws.ID); err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(ws.Path, "project")
	if err := os.Mkdir(project, 0o700); err != nil {
		t.Fatal(err)
	}
	live := observedEnrollment(ws, "initial-empty")
	live.Cwd = project
	caller.sessions = []rpcwatch.Session{live}
	// When: the first daemon observation reaches the enrollment service.
	s.rpcWatcher.Tick(t.Context())
	// Then: basename workspace and normal in-place chat exist without a click.
	workspaces := store.ListWorkspaces()
	if len(workspaces) != 1 || workspaces[0].Name != "project" {
		t.Fatalf("auto workspace = %+v", workspaces)
	}
	chats := store.ListChats(workspaces[0].ID)
	if len(chats) != 1 || !chats[0].AutoEnrolled || chats[0].SessionFile != live.SessionPath || chats[0].DurableSessionID != live.DurableSessionID || chats[0].CWD != project {
		t.Fatalf("auto chat = %+v", chats)
	}
	page := listWorkspaceSessions(t, s, workspaces[0].ID, "")
	if len(page.Items) != 1 || !page.Items[0].Live {
		t.Fatalf("initial live projection = %+v", page.Items)
	}
}
