package api

import (
	"fmt"
	"testing"
)

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
