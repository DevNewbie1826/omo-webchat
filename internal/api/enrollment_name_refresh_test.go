package api

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/rpcwatch"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

// namedEnrollmentFixture is the plain enrollment fixture plus the manager a
// running server always has, so a tick can hand a daemon name to a live
// session. The manager owns no client: only the route lookup is exercised.
func namedEnrollmentFixture(t *testing.T) (*Server, *cursorstore.Store, *enrollmentCaller, cursorstore.Workspace) {
	t.Helper()
	s, store, caller, ws := enrollmentFixture(t)
	s.manager = session.NewManager(session.Config{Store: (*wsbridge.CursorStore)(store)})
	t.Cleanup(func() {
		if err := s.manager.CloseAll(context.Background()); err != nil {
			t.Error(err)
		}
	})
	return s, store, caller, ws
}

// namedEnrolledChat stores a chat whose identity already matches the session
// observedEnrollment reports for the same durable id.
func namedEnrolledChat(ws cursorstore.Workspace, id, durable, name, source string) cursorstore.Chat {
	return cursorstore.Chat{ID: id, WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: filepath.Join(ws.Path, durable+".jsonl"),
		DurableSessionID: durable, AutoEnrolled: true, Name: name, NameSource: source, CreatedAt: time.Now().UnixMilli()}
}

func TestEnrollmentTickRefreshesUnboundAutoName(t *testing.T) {
	s, store, caller, ws := namedEnrollmentFixture(t)
	chat := namedEnrolledChat(ws, "unbound-auto", "durable-unbound-auto", "Old", cursorstore.NameSourceAuto)
	if err := store.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	live := observedEnrollment(ws, chat.DurableSessionID)
	live.Name = "New"
	caller.sessions = []rpcwatch.Session{live}

	// One snapshot must carry the rpc rename into the stored name of a chat
	// that is not open in webchat; nothing else refreshes it.
	s.rpcWatcher.Tick(t.Context())

	updated, err := store.GetChat(chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != "New" || updated.NameSource != cursorstore.NameSourceAuto || updated.TitleIsPlaceholder {
		t.Fatalf("unbound auto rename = %+v", updated)
	}
}

func TestEnrollmentTickKeepsUserNamedChat(t *testing.T) {
	s, store, caller, ws := namedEnrollmentFixture(t)
	chat := namedEnrolledChat(ws, "user-named", "durable-user-named", "User title", cursorstore.NameSourceUser)
	if err := store.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	live := observedEnrollment(ws, chat.DurableSessionID)
	live.Name = "Daemon title"
	caller.sessions = []rpcwatch.Session{live}

	// A name the webchat user chose outranks the daemon's name (decision D1).
	s.rpcWatcher.Tick(t.Context())

	updated, err := store.GetChat(chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != "User title" || updated.NameSource != cursorstore.NameSourceUser {
		t.Fatalf("tick overwrote the webchat user rename = %+v", updated)
	}
}

func TestEnrollmentTickKeepsLegacySourcedName(t *testing.T) {
	s, store, caller, ws := namedEnrollmentFixture(t)
	chat := namedEnrolledChat(ws, "legacy-named", "durable-legacy-named", "Legacy title", "")
	if err := store.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	live := observedEnrollment(ws, chat.DurableSessionID)
	live.Name = "Daemon title"
	caller.sessions = []rpcwatch.Session{live}

	// A stored name whose source is unknown (legacy record) is established:
	// only an automatic name may be replaced by the daemon's newer one.
	s.rpcWatcher.Tick(t.Context())

	updated, err := store.GetChat(chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != "Legacy title" || updated.NameSource != "" {
		t.Fatalf("tick replaced a legacy empty-source name = %+v", updated)
	}
}

func TestEnrollmentTickRoutesDaemonNameToBoundSession(t *testing.T) {
	s, store, caller, ws := enrollmentFixture(t)
	daemonDir, err := os.MkdirTemp("", "enrollment-bound-name-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(daemonDir) })
	daemon := omorpctest.New(daemonDir)
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(daemon.Stop)
	client, err := omorpc.Dial(t.Context(), daemon.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	manager := session.NewManager(session.Config{Client: client, Store: (*wsbridge.CursorStore)(store)})
	s.manager = manager
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = manager.CloseAll(ctx)
		_ = client.Close()
	})

	chat := cursorstore.Chat{ID: "bound-name", WorkspaceID: ws.ID, CWD: ws.Path, Name: "Old",
		NameSource: cursorstore.NameSourceAuto, CreatedAt: time.Now().UnixMilli()}
	if err := store.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	sub := &adoptionSessionSubscriber{frames: make(chan session.Frame, 32)}
	_, _, detach, err := manager.Acquire(t.Context(), adoptionChatRef{chat: chat}, sub)
	if err != nil {
		t.Fatal(err)
	}
	defer detach()
	sub.await(t, session.FrameReady)

	updates := make(chan session.Summary, 8)
	stop := manager.SubscribeOverview(func(row session.Summary) {
		select {
		case updates <- row:
		default:
		}
	})
	defer stop()

	bound, err := store.GetChat(chat.ID)
	if err != nil || bound.DurableSessionID == "" || bound.SessionFile == "" {
		t.Fatalf("bound identity = %+v, %v", bound, err)
	}
	live := observedEnrollment(ws, bound.DurableSessionID)
	live.SessionPath = bound.SessionFile
	live.Name = "Daemon rename"
	caller.sessions = []rpcwatch.Session{live}

	s.rpcWatcher.Tick(t.Context())

	// A route-bound session owns its title: the tick must hand the daemon name
	// to the session instead of writing the store behind its back.
	frame := awaitNameFrame(t, sub, "Daemon rename")
	data, _ := frame.Data.(map[string]any)
	if data["origin"] != "provider" {
		t.Fatalf("bound name frame = %+v", frame)
	}
	awaitSummaryTitle(t, updates, chat.ID, "Daemon rename")
	updated, err := store.GetChat(chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != "Daemon rename" || updated.NameSource != cursorstore.NameSourceAuto {
		t.Fatalf("bound stored name = %+v", updated)
	}
}

// awaitNameFrame waits for a name frame carrying want, skipping the frames a
// session publishes while it opens.
func awaitNameFrame(t *testing.T, sub *adoptionSessionSubscriber, want string) session.Frame {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case frame := <-sub.frames:
			if frame.Kind != session.FrameName {
				continue
			}
			if data, _ := frame.Data.(map[string]any); data["name"] == want {
				return frame
			}
		case <-timer.C:
			t.Fatalf("timed out waiting for the %q name frame", want)
			return session.Frame{}
		}
	}
}

func awaitSummaryTitle(t *testing.T, updates <-chan session.Summary, chatID, want string) {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case row := <-updates:
			if row.ChatID == chatID && row.Title == want {
				return
			}
		case <-timer.C:
			t.Fatalf("timed out waiting for summary title %q on %s", want, chatID)
		}
	}
}
