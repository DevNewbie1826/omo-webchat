package coldhistory

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestTodoProjectionSelectedBranchBudgets(t *testing.T) {
	disk := `{"type":"session","id":"synthetic"}` + "\n" + `{"type":"custom","id":"a","parentId":null}` + "\n"
	for _, tc := range []struct {
		name    string
		options SelectedOptions
		want    error
	}{
		{"index", SelectedOptions{Options: Options{IndexBytes: 1}}, ErrIndexBudgetExceeded},
		{"disk-line", SelectedOptions{Options: Options{MaxLineBytes: 10}}, ErrLineTooLong},
		{"identity", SelectedOptions{ExpectedSessionID: "other"}, ErrInvalidHeader},
		{"boundary", SelectedOptions{RequiredEntryID: "not-persisted"}, ErrBrokenBranch},
		{"tail-budget", SelectedOptions{Options: Options{MaxLineBytes: 64, PageBytes: 64}, ResolveTail: func(context.Context, string) (SelectedTail, error) {
			return SelectedTail{Entries: []json.RawMessage{json.RawMessage(`{"type":"custom","id":"b","parentId":"a"}`), json.RawMessage(`{"type":"custom","id":"c","parentId":"b"}`)}, LeafID: "c"}, nil
		}}, ErrLineTooLong},
	} {
		t.Run(tc.name, func(t *testing.T) {
			emitted := false
			_, err := ReadSelectedBranch(t.Context(), strings.NewReader(disk), tc.options, func(Metadata, Page) error { emitted = true; return nil })
			if !errors.Is(err, tc.want) || emitted {
				t.Fatalf("budget/identity err=%v emitted=%v", err, emitted)
			}
		})
	}
}

func TestTodoProjectionSelectedBranchCallbackAndCancellation(t *testing.T) {
	disk := []byte("{\"type\":\"session\",\"id\":\"synthetic\"}\n{\"type\":\"custom\",\"id\":\"a\",\"parentId\":null}\n")
	ctx, cancel := context.WithCancel(t.Context())
	_, err := ReadSelectedBranch(ctx, bytes.NewReader(disk), SelectedOptions{}, func(Metadata, Page) error { cancel(); return nil })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled callback=%v", err)
	}
	want := errors.New("callback failed")
	_, err = ReadSelectedBranch(t.Context(), bytes.NewReader(disk), SelectedOptions{}, func(Metadata, Page) error { return want })
	if !errors.Is(err, want) {
		t.Fatalf("callback error=%v", err)
	}
}
