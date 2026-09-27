package wsbridge

import (
	"errors"
	"log/slog"
	"net"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

func TestSubscriberCancelRecordsActualWriteFailure(t *testing.T) {
	for _, cause := range []string{"write_timeout", "closed", "detached"} {
		t.Run(cause, func(t *testing.T) {
			// Given an actual upgraded socket, use a private writer binding
			// so the test never races changes to the running handler config.
			h := newInPlaceBridgeHarness(t, "cancel-cause")
			client, frames := h.connect(t)
			awaitCommandFence(t, client, frames)
			server := h.soleServerConnection(t)
			log := &subscriberBehaviorLog{}
			writer := &connection{
				socket: server.socket,
				bridge: &Handler{cfg: Config{Logger: slog.New(slog.NewJSONHandler(log, nil)), WriteTimeout: time.Second}},
				chatID: "cancel-cause", sess: &session.Session{}, bindingGeneration: 1,
			}
			sub := newSubscriber(writer)
			writer.sub = sub
			writer.todoBindingID = sub.bindingID
			sub.active = true
			sub.claim = queryBinding{chatID: writer.chatID, session: writer.sess, generation: 1, bindingID: sub.bindingID}
			switch cause {
			case "write_timeout":
				// An already expired write deadline yields a real net.Error
				// without depending on TCP buffer size or wall-clock waiting.
				writer.bridge.cfg.WriteTimeout = -time.Second
			case "closed":
				if err := writer.socket.NetConn().Close(); err != nil {
					t.Fatal(err)
				}
			}

			// When a real delivery fails, Cancel reports that exact cause.
			if cause != "detached" {
				err := sub.DeliverFrame(session.Frame{Kind: session.FrameName, Data: map[string]any{"name": "diagnostic"}})
				if err == nil {
					t.Fatal("write unexpectedly succeeded")
				}
				var networkError net.Error
				if cause == "write_timeout" && (!errors.As(err, &networkError) || !networkError.Timeout()) {
					t.Fatalf("write error=%v, want net.Error timeout", err)
				}
			}
			if err := sub.Cancel(); err != nil {
				t.Fatal(err)
			}

			// Then the structured diagnostic distinguishes transport failure
			// from ordinary detachment and carries the attempted wire shape.
			if !log.has(t, "cause", cause) {
				t.Fatalf("cancel omitted cause=%s", cause)
			}
			if cause != "detached" {
				if !log.has(t, "kind", string(session.FrameName)) || sub.lastWriteSize <= 0 {
					t.Fatalf("cancel omitted frame kind/size: kind=%s size=%d", sub.lastWriteKind, sub.lastWriteSize)
				}
			}
		})
	}
}
