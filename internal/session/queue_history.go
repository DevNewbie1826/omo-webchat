package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/DevNewbie1826/omo-webchat/internal/coldhistory"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

// inspectQueueHistory is separate from active-branch UI replay. It keeps one
// finite descriptor snapshot and only graph coordinates/match flags, validates
// its file-order end against the owning daemon epoch, then rechecks all fences.
// Retained entries are immutable under the existing local trust model; these
// metadata fences detect concurrent edits, not authenticated historical content.
func (s *Session) inspectQueueHistory(ctx context.Context, match func(json.RawMessage) bool, inspect func(*coldhistory.FileOrder, string) error) error {
	s.lifecycleMu.Lock()
	route, routeErr := s.routeLocked()
	epoch, path, id := s.epoch, s.sessionFile, s.durableID
	identity, initialErr := s.queueFileIdentity, s.queueFileErr
	acquiredIdentity := s.sessionFileIdentity
	fresh := !s.resumed && !s.inPlace && !s.queueHistoryEstablished
	absentAllowed := fresh && !s.sessionFileObserved && identity == nil && errors.Is(initialErr, os.ErrNotExist)
	s.lifecycleMu.Unlock()
	fail := s.queueHistoryError
	if routeErr != nil {
		return routeErr
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if initialErr != nil && !errors.Is(initialErr, os.ErrNotExist) {
		return fail(initialErr)
	}
	if !s.client.EpochCurrent(epoch) {
		return omorpc.ErrEpochMismatch
	}

	before, err := os.Lstat(path)
	var file *os.File
	var order *coldhistory.FileOrder
	if errors.Is(err, os.ErrNotExist) && absentAllowed {
		// Only a newly opened native route whose file has never existed can
		// establish its start boundary with a request-local bounded root query.
		header, _ := json.Marshal(map[string]string{"type": "session", "id": id})
		order, err = coldhistory.InspectFileOrder(ctx, bytes.NewReader(append(header, '\n')), coldhistory.Options{}, match)
	} else if err == nil {
		s.lifecycleMu.Lock()
		s.sessionFileObserved = true
		s.lifecycleMu.Unlock()
		if err = queueFileIdentityError(identity, before); err != nil {
			return fail(err)
		}
		if err = queueFileIdentityError(acquiredIdentity, before); err != nil {
			return fail(err)
		}
		file, err = os.Open(path)
		if err != nil {
			return fail(err)
		}
		defer file.Close()
		if err = checkQueueSnapshot(path, file, before); err != nil {
			return fail(err)
		}
		order, err = coldhistory.InspectFileOrder(ctx, io.NewSectionReader(file, 0, before.Size()), coldhistory.Options{}, match)
	}
	if err != nil {
		return fail(err)
	}
	if order.Header.ID != id {
		return fail(fmt.Errorf("%w: disk session id %q does not match %q", errIncompleteHistory, order.Header.ID, id))
	}
	if order.EndID == "" && !fresh {
		return fail(fmt.Errorf("%w: established session has no entry boundary", errIncompleteHistory))
	}
	if file != nil {
		if err := checkQueueSnapshot(path, file, before); err != nil {
			return fail(err)
		}
	}

	diskEnd := order.EndID
	resp, responseEpoch, err := s.client.CallInEpochToken(ctx, epoch, omorpc.GetEntries{SessionID: route, Since: diskEnd})
	if err != nil {
		if errors.Is(err, omorpc.ErrDisconnected) {
			s.manager.invalidateEpoch(epoch)
		}
		err = s.classifyRouteError(err)
		if resp != nil && !resp.Success && !errors.Is(err, ErrSessionResumable) {
			// In particular, a real unknown-cursor failure proves disk/daemon
			// disagreement. Preserve its cause, with no root-query fallback.
			return fail(err)
		}
		return err
	}
	if responseEpoch != epoch || resp.SessionID != route {
		return fail(fmt.Errorf("%w: queue response route/epoch mismatch", errIncompleteHistory))
	}
	var wire struct {
		Entries []json.RawMessage `json:"entries"`
		LeafID  json.RawMessage   `json:"leafId"`
	}
	if err := json.Unmarshal(resp.Data, &wire); err != nil {
		return fail(fmt.Errorf("invalid queue get_entries response: %w", err))
	}
	var leaf string
	if err := json.Unmarshal(wire.LeafID, &leaf); err != nil {
		return fail(fmt.Errorf("invalid queue get_entries leaf: %w", err))
	}
	// Require the actual entries field; null/missing is not proof of emptiness.
	if wire.Entries == nil {
		return fail(fmt.Errorf("%w: missing queue entries", errIncompleteHistory))
	}
	if err := order.AddTail(ctx, wire.Entries, leaf, match); err != nil {
		return fail(err)
	}
	if err := inspect(order, leaf); err != nil {
		return fail(err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if file != nil {
		if err := checkQueueSnapshot(path, file, before); err != nil {
			return fail(err)
		}
	} else if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		if err == nil {
			err = fmt.Errorf("%w: native session file appeared during inspection", errIncompleteHistory)
		}
		return fail(err)
	}
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	current, err := s.routeLocked()
	if err != nil {
		return err
	}
	if current != route || s.epoch != epoch || s.sessionFile != path || s.durableID != id || !s.client.EpochCurrent(epoch) {
		return omorpc.ErrEpochMismatch
	}
	if before != nil {
		s.queueFileIdentity, s.queueFileErr = before, nil
	}
	if order.EndID != "" {
		s.queueHistoryEstablished = true
	}
	return nil
}

func queueFileIdentityError(identity, current os.FileInfo) error {
	if !current.Mode().IsRegular() {
		return fmt.Errorf("%w: session path is not a regular file", errIncompleteHistory)
	}
	if current.Mode().Perm()&0o444 == 0 {
		return os.ErrPermission
	}
	if identity != nil && (!os.SameFile(identity, current) || current.Size() < identity.Size()) {
		return fmt.Errorf("%w: session file identity changed or file shrank", errIncompleteHistory)
	}
	return nil
}

func checkQueueSnapshot(path string, file *os.File, before os.FileInfo) error {
	for _, stat := range []func() (os.FileInfo, error){file.Stat, func() (os.FileInfo, error) { return os.Lstat(path) }} {
		now, err := stat()
		if err != nil {
			return err
		}
		if err := queueFileIdentityError(before, now); err != nil {
			return err
		}
		if now.Size() != before.Size() || !now.ModTime().Equal(before.ModTime()) || now.Mode() != before.Mode() {
			return fmt.Errorf("%w: session file changed during queue inspection", errIncompleteHistory)
		}
	}
	return nil
}

func (s *Session) queueHistoryError(err error) error {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	s.lifecycleMu.Lock()
	inPlace := s.inPlace
	s.lifecycleMu.Unlock()
	if inPlace {
		drift := &ExternalWriteError{Reason: "queue history authority unavailable: " + err.Error(), cause: err}
		s.quarantineExternalWrite(drift, nil)
		return drift
	}
	return err
}
