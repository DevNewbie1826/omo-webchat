package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/coldhistory"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

// todoReadState belongs to the bound Session even after provider eviction.
// mu serializes readers; lifecycleMu protects the file-observation fields.
type todoReadState struct {
	mu             sync.Mutex
	identity       os.FileInfo
	observed       bool
	boundary       string
	selectedLeaf   string
	selectionKnown bool
}

// ReadTodoProjection never acquires, resumes, prepares a write, or publishes
// transcript frames. Resident reads use one epoch-local suffix request; closed
// or unloaded sessions read disk only. Errors carry no replacement state.
func (s *Session) ReadTodoProjection(ctx context.Context) (TodoProjection, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	s.todoRead.mu.Lock()
	defer s.todoRead.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return TodoProjection{}, err
	}
	s.lifecycleMu.Lock()
	route, epoch, path, id := s.routingID, s.epoch, s.sessionFile, s.durableID
	closed, resumable, invalidated := s.closed, s.resumable, s.invalidated
	resident := !closed && !resumable && !invalidated
	identity, acquired, observedIdentity := s.queueFileIdentity, s.sessionFileIdentity, s.todoRead.identity
	absentAllowed := resident && !s.resumed && !s.inPlace && !s.sessionFileObserved && !s.todoRead.observed && identity == nil && errors.Is(s.queueFileErr, os.ErrNotExist)
	boundary := s.todoRead.boundary
	selectedLeaf, selectionKnown := s.todoRead.selectedLeaf, s.todoRead.selectionKnown
	quarantine, closing := s.quarantineErr, s.closing
	s.lifecycleMu.Unlock()
	if quarantine != nil {
		return TodoProjection{}, quarantine
	}
	if closing {
		return TodoProjection{}, ErrSessionClosed
	}
	if resident && !s.client.EpochCurrent(epoch) {
		return TodoProjection{}, omorpc.ErrEpochMismatch
	}
	before, err := os.Lstat(path)
	var source io.ReadSeeker
	var file *os.File
	if errors.Is(err, os.ErrNotExist) && absentAllowed {
		header, marshalErr := json.Marshal(map[string]string{"type": "session", "id": id})
		if marshalErr != nil {
			return TodoProjection{}, marshalErr
		}
		source = bytes.NewReader(append(header, '\n'))
	} else if err == nil {
		s.lifecycleMu.Lock()
		s.todoRead.observed = true
		s.lifecycleMu.Unlock()
		for _, known := range []os.FileInfo{identity, acquired, observedIdentity} {
			if err := queueFileIdentityError(known, before); err != nil {
				return TodoProjection{}, err
			}
		}
		file, err = os.Open(path)
		if err != nil {
			return TodoProjection{}, err
		}
		defer file.Close()
		if err := checkQueueSnapshot(path, file, before); err != nil {
			return TodoProjection{}, err
		}
		source = io.NewSectionReader(file, 0, before.Size())
	} else {
		return TodoProjection{}, err
	}
	checkFile := func() error {
		if file != nil {
			return checkQueueSnapshot(path, file, before)
		}
		if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
			if err != nil {
				return err
			}
			return fmt.Errorf("%w: native session file appeared during todo read", errIncompleteHistory)
		}
		return nil
	}
	options := coldhistory.SelectedOptions{ExpectedSessionID: id}
	if !resident {
		options.RequiredEntryID = boundary
		if selectionKnown {
			// Eviction is not a branch selection. Preserve the resident leaf
			// at its file-order boundary; only an advanced disk end selects anew.
			options.ResolveTail = func(_ context.Context, end string) (coldhistory.SelectedTail, error) {
				leaf := end
				if end == boundary {
					leaf = selectedLeaf
				}
				return coldhistory.SelectedTail{LeafID: leaf}, nil
			}
		}
	}
	if resident {
		options.ResolveTail = func(ctx context.Context, end string) (coldhistory.SelectedTail, error) {
			if err := checkFile(); err != nil {
				return coldhistory.SelectedTail{}, err
			}
			resp, responseEpoch, err := s.client.CallInEpochToken(ctx, epoch, omorpc.GetEntries{SessionID: route, Since: end})
			if err != nil {
				return coldhistory.SelectedTail{}, err
			}
			if responseEpoch != epoch || resp.SessionID != route {
				return coldhistory.SelectedTail{}, omorpc.ErrEpochMismatch
			}
			var wire struct {
				Entries []json.RawMessage
				LeafID  json.RawMessage
			}
			if json.Unmarshal(resp.Data, &wire) != nil || wire.Entries == nil || len(wire.LeafID) == 0 {
				return coldhistory.SelectedTail{}, errIncompleteHistory
			}
			var leaf string
			if err := json.Unmarshal(wire.LeafID, &leaf); err != nil {
				return coldhistory.SelectedTail{}, errIncompleteHistory
			}
			return coldhistory.SelectedTail{Entries: wire.Entries, LeafID: leaf}, nil
		}
	}
	var fold todoFold
	selected, err := coldhistory.ReadSelectedBranch(ctx, source, options, fold.consume)
	if err != nil {
		return TodoProjection{}, err
	}
	projection, err := fold.finish(selected.LeafID)
	if err != nil {
		return TodoProjection{}, err
	}
	if err := checkFile(); err != nil {
		return TodoProjection{}, err
	}
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	if err := ctx.Err(); err != nil {
		return TodoProjection{}, err
	}
	if s.routingID != route || s.epoch != epoch || s.sessionFile != path || s.durableID != id || s.closed != closed || s.resumable != resumable || s.invalidated != invalidated || s.closing || s.quarantineErr != nil {
		return TodoProjection{}, omorpc.ErrEpochMismatch
	}
	if resident && !s.client.EpochCurrent(epoch) {
		return TodoProjection{}, omorpc.ErrEpochMismatch
	}
	if before != nil {
		s.todoRead.identity = before
	}
	if resident {
		s.todoRead.boundary = selected.EndID
		s.todoRead.selectedLeaf = selected.LeafID
		s.todoRead.selectionKnown = true
	}
	return projection, nil
}
