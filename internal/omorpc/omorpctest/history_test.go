package omorpctest

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestHistoryEmptyArrayAndUnknownCursor(t *testing.T) {
	q := newQueueTest(t)
	ctx, cancel := context.WithTimeout(t.Context(), queueTestAwait)
	defer cancel()
	response, err := q.c.Call(ctx, omorpc.GetEntries{SessionID: q.rpc})
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		Entries []json.RawMessage `json:"entries"`
	}
	if err := json.Unmarshal(response.Data, &body); err != nil {
		t.Fatal(err)
	}
	if body.Entries == nil {
		t.Error("empty retained history must be an array, not null")
	}
	if _, err := q.c.Call(ctx, omorpc.GetEntries{SessionID: q.rpc, Since: "not-retained"}); err == nil {
		t.Fatal("unknown cursor returned empty success instead of provider error")
	}
}
