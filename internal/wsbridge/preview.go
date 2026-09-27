package wsbridge

import (
	"context"
	"encoding/json"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/coldhistory"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

const previewTimeout = 750 * time.Millisecond

var streamPreviewHistory = coldhistory.StreamTailFirst

// previewHistory is provisional: it never enters the subscriber's hydration
// or resume accounting, and normal engine-backed replay still follows.
func (c *connection) previewHistory(ctx context.Context, f *wscontract.ChatCreateFrame, rec cursorstore.Chat, sub *subscriber) {
	c.stateMu.Lock()
	version, generation, current := c.helloVersion, c.bindingGeneration, c.sub == sub
	c.stateMu.Unlock()
	if !current || version < onDemandHistoryVersion ||
		(f.Resume != nil && f.Resume.SessionID != "" && f.Resume.FirstEntryID != "" && f.Resume.LastEntryID != "") ||
		rec.SessionFile == "" || rec.DurableSessionID == "" {
		return
	}

	ctx, cancel := context.WithTimeout(ctx, previewTimeout)
	defer cancel()
	entries := make([]json.RawMessage, 0, coldhistory.DefaultTailEntries)
	complete := false
	metadata, err := streamPreviewHistory(ctx, rec.SessionFile, coldhistory.Options{SkipWarm: true},
		coldhistory.DefaultTailEntries, 0, func(meta coldhistory.Metadata, page coldhistory.Page) error {
			if meta.Header.ID != rec.DurableSessionID {
				return coldhistory.ErrInvalidHeader
			}
			if len(entries) == 0 {
				complete = page.Start == 0
			}
			entries = append(entries, page.Entries...)
			return ctx.Err()
		})
	if err != nil || ctx.Err() != nil || metadata.Header.ID != rec.DurableSessionID {
		return
	}
	segment := "preview"
	frame := wscontract.EntriesFrame{
		Type: "entries", SessionID: rec.ID, HistorySessionID: &rec.DurableSessionID,
		Entries: entries, Final: false, Segment: &segment, HistoryComplete: &complete,
	}
	// Keep the create claim through the serialized socket write, just as
	// writeIfCurrent does for frames after a session has been acquired.
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if c.closed.Load() || c.sub != sub || c.bindingGeneration != generation || ctx.Err() != nil {
		return
	}
	if err := c.write(frame); err != nil {
		return
	}
}
