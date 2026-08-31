package api

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/chat"
)

// TestFindSessionBranchesByName pins the dangling-recovery branch scan on a
// disk fixture: session_info records whose name exactly matches the chat name
// become candidates in file-then-line order, an oversized line that would
// otherwise match is skipped unparsed, records with other names are ignored,
// and the scan stops at the 8-candidate cap.
func TestFindSessionBranchesByName(t *testing.T) {
	_, _, ws, agent := newSessionHistoryTestServer(t)
	dir := filepath.Join(agent, "sessions", sessionDirNameForCwd(ws.Path))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	const chatName = "Dangling chat first message"

	// a-host.jsonl: header, first match, a differently named record that must
	// be ignored, an oversized line that WOULD match (must be skipped), then a
	// second match after it.
	oversized := `{"type":"session_info","id":"br-too-big","parentId":"host-a","name":"` + chatName + `","pad":"` + strings.Repeat("x", sessionHistoryMaxJSONLLine) + `"}`
	hostA := strings.Join([]string{
		`{"type":"session","version":3,"id":"host-a","timestamp":"2026-01-02T03:04:05Z"}`,
		fmt.Sprintf(`{"type":"session_info","id":"br-1","parentId":"host-a","name":%q,"timestamp":"2026-01-02T03:04:06Z"}`, chatName),
		`{"type":"session_info","id":"br-other","name":"Some other chat"}`,
		oversized,
		fmt.Sprintf(`{"type":"session_info","id":"br-2","parentId":"host-a","name":%q,"timestamp":"2026-01-02T03:04:07Z"}`, chatName),
		"",
	}, "\n")
	if err := os.WriteFile(filepath.Join(dir, "a-host.jsonl"), []byte(hostA), 0o600); err != nil {
		t.Fatal(err)
	}

	// b-many.jsonl: twelve further matches so the scan must stop at the
	// sessionBranchScanMaxCandidates cap.
	lines := []string{`{"type":"session","version":3,"id":"host-b","timestamp":"2026-01-02T03:04:05Z"}`}
	for i := 0; i < 12; i++ {
		lines = append(lines, fmt.Sprintf(`{"type":"session_info","id":"br-b%02d","parentId":"host-b","name":%q}`, i, chatName))
	}
	if err := os.WriteFile(filepath.Join(dir, "b-many.jsonl"), []byte(strings.Join(append(lines, ""), "\n")), 0o600); err != nil {
		t.Fatal(err)
	}

	candidates := findSessionBranchesByName(ws.Path, chatName)
	if len(candidates) != sessionBranchScanMaxCandidates {
		t.Fatalf("candidates = %d, want the %d cap", len(candidates), sessionBranchScanMaxCandidates)
	}
	hostAPath := filepath.Join(dir, "a-host.jsonl")
	hostBPath := filepath.Join(dir, "b-many.jsonl")
	want := []chat.SessionBranchCandidate{
		{ID: "br-1", ParentID: "host-a", Name: chatName, HostPath: hostAPath},
		{ID: "br-2", ParentID: "host-a", Name: chatName, HostPath: hostAPath},
		{ID: "br-b00", ParentID: "host-b", Name: chatName, HostPath: hostBPath},
		{ID: "br-b01", ParentID: "host-b", Name: chatName, HostPath: hostBPath},
		{ID: "br-b02", ParentID: "host-b", Name: chatName, HostPath: hostBPath},
		{ID: "br-b03", ParentID: "host-b", Name: chatName, HostPath: hostBPath},
		{ID: "br-b04", ParentID: "host-b", Name: chatName, HostPath: hostBPath},
		{ID: "br-b05", ParentID: "host-b", Name: chatName, HostPath: hostBPath},
	}
	for i, wantCandidate := range want {
		if candidates[i] != wantCandidate {
			t.Fatalf("candidates[%d] = %+v, want %+v (order must follow file-then-line order)", i, candidates[i], wantCandidate)
		}
	}

	// A differently named chat yields nothing, even though matches exist.
	if got := findSessionBranchesByName(ws.Path, "No such chat"); len(got) != 0 {
		t.Fatalf("non-matching name returned %d candidates, want 0: %+v", len(got), got)
	}
	if got := findSessionBranchesByName(ws.Path, ""); got != nil {
		t.Fatalf("empty chat name returned %+v, want nil", got)
	}
}
