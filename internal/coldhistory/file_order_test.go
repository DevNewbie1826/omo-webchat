package coldhistory

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestFileOrderInspectionBoundsAndGraph(t *testing.T) {
	header := "{\"type\":\"session\",\"id\":\"durable\"}\n"
	root := "{\"type\":\"message\",\"id\":\"root\",\"parentId\":null}\n"
	for _, tc := range []struct {
		name, body string
		opts       Options
		want       error
	}{
		{"empty", "", Options{}, ErrEmpty},
		{"bad-header", "{}\n", Options{}, ErrInvalidHeader},
		{"malformed", header + "bad\n", Options{}, ErrCorruptLine},
		{"torn", header + "{", Options{}, ErrCorruptLine},
		{"unterminated", header + strings.TrimSuffix(root, "\n"), Options{}, ErrCorruptLine},
		{"duplicate", header + root + root, Options{}, ErrDuplicateID},
		{"broken", header + strings.Replace(root, "null", "\"missing\"", 1), Options{}, ErrBrokenBranch},
		{"self-cycle", header + strings.Replace(root, "null", "\"root\"", 1), Options{}, ErrBrokenBranch},
		{"line-budget", header + root, Options{MaxLineBytes: 40}, ErrLineTooLong},
		{"index-budget", header + root, Options{IndexBytes: 1}, ErrIndexBudgetExceeded},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := InspectFileOrder(t.Context(), strings.NewReader(tc.body), tc.opts, nil)
			if !errors.Is(err, tc.want) {
				t.Fatalf("err=%v want=%v", err, tc.want)
			}
		})
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := InspectFileOrder(ctx, strings.NewReader(header+root), Options{}, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel=%v", err)
	}
}

func TestFileOrderTailAndAncestry(t *testing.T) {
	body := "{\"type\":\"session\",\"id\":\"durable\"}\n" +
		"{\"type\":\"message\",\"id\":\"root\",\"parentId\":null}\n" +
		"{\"type\":\"message\",\"id\":\"old\",\"parentId\":\"root\"}\n" +
		"{\"type\":\"message\",\"id\":\"accepted\",\"parentId\":\"old\"}\n" +
		"{\"type\":\"message\",\"id\":\"end\",\"parentId\":\"root\"}\n"
	for _, tc := range []struct {
		name    string
		tail    []json.RawMessage
		leaf    string
		wantErr bool
	}{
		{"empty", nil, "end", false},
		{"branch-tail", []json.RawMessage{json.RawMessage(`{"type":"message","id":"new","parentId":"old"}`)}, "new", false},
		{"duplicate", []json.RawMessage{json.RawMessage(`{"type":"message","id":"old","parentId":"root"}`)}, "old", true},
		{"missing-parent", []json.RawMessage{json.RawMessage(`{"type":"message","id":"new","parentId":"missing"}`)}, "new", true},
		{"missing-leaf", nil, "missing", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			order, err := InspectFileOrder(t.Context(), strings.NewReader(body), Options{}, func(raw json.RawMessage) bool { return strings.Contains(string(raw), `"id":"accepted"`) })
			if err != nil {
				t.Fatal(err)
			}
			err = order.AddTail(t.Context(), tc.tail, tc.leaf, nil)
			if (err != nil) != tc.wantErr {
				t.Fatalf("tail=%v", err)
			}
			if err != nil {
				return
			}
			if yes, err := order.MatchAfter("old", tc.leaf); !yes || err != nil {
				t.Fatalf("offbranch positive=%v %v", yes, err)
			}
			if _, err := order.MatchAfter("missing", tc.leaf); err == nil {
				t.Fatal("missing cursor permitted")
			}
			if _, err := order.Checkpoint("root"); err == nil {
				t.Fatal("moved back leaf became checkpoint")
			}
		})
	}
}
