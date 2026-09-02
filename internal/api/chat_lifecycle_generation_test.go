package api

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

func TestPrepareChatRejectsUnsupportedProvider(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	chat := cursorstore.Chat{ID: "unsupported", WorkspaceID: ws.ID, CWD: ws.Path, Provider: "omp", Name: "legacy", CreatedAt: 1}
	if err := st.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	if _, err := s.prepareChatVersion(context.Background(), ws.ID, chat.ID); !errors.Is(err, wsbridge.ErrUnsupportedProvider) {
		t.Fatalf("prepare error = %v, want ErrUnsupportedProvider", err)
	}
}

func TestChatLifecycleGenerationsAreBounded(t *testing.T) {
	s := &Server{}
	for i := 0; i < maxChatLifecycleGenerationRecords+200; i++ {
		s.bumpChatLifecycleVersion(fmt.Sprintf("deleted-chat-%d", i))
	}
	entries := 0
	s.chatLifecycleGeneration.Range(func(_, _ any) bool {
		entries++
		return true
	})
	if entries > maxChatLifecycleGenerationRecords {
		t.Fatalf("lifecycle generations = %d, bound %d", entries, maxChatLifecycleGenerationRecords)
	}
	if got := len(s.chatLifecycleGenerationFIFO); got != maxChatLifecycleGenerationRecords {
		t.Fatalf("lifecycle generation FIFO = %d, want %d", got, maxChatLifecycleGenerationRecords)
	}
}
