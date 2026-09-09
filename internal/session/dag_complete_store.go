package session

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
)

var errDagStoreAbsent = errors.New("DAG store does not exist")

// openDagDirectory pins every directory beneath the validated cwd. Root's
// traversal confinement also protects the lstat/open race; identity checks
// reject replacement and no component is allowed to be a symlink.
func openDagDirectory(cwd string, components ...string) (*os.Root, error) {
	root, err := os.OpenRoot(cwd)
	if err != nil {
		return nil, ErrDagNotFound
	}
	for _, component := range components {
		before, err := root.Lstat(component)
		if errors.Is(err, os.ErrNotExist) {
			root.Close()
			return nil, errDagStoreAbsent
		}
		if err != nil || !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
			root.Close()
			return nil, ErrDagNotFound
		}
		next, err := root.OpenRoot(component)
		root.Close()
		if err != nil {
			return nil, ErrDagNotFound
		}
		after, err := next.Stat(".")
		if err != nil || !os.SameFile(before, after) {
			next.Close()
			return nil, ErrDagNotFound
		}
		root = next
	}
	return root, nil
}

// readCompleteSource reads a pinned regular file without legacy byte limits.
// Atomic rename can retire this descriptor, but cannot mix its contents with
// the replacement. In-place changes are explicit conflicts, never retried in
// a heartbeat-dependent loop. All projection and hashing use these same bytes.
func readCompleteSource(ctx context.Context, root *os.Root, name string) ([]byte, error) {
	before, err := root.Lstat(name)
	if err != nil {
		return nil, ErrDagSourceChanged
	}
	if !before.Mode().IsRegular() {
		return nil, ErrDagNotFound
	}
	f, err := root.Open(name)
	if err != nil {
		return nil, ErrDagInvalidSource
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !sameFileState(before, opened) {
		return nil, ErrDagSourceChanged
	}
	data, err := io.ReadAll(contextReader{ctx: ctx, r: f})
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, ErrDagInvalidSource
	}
	after, err := f.Stat()
	if err != nil || !sameFileState(opened, after) {
		return nil, ErrDagSourceChanged
	}
	return data, nil
}

func visitDagSources(ctx context.Context, root *os.Root, visit func([]byte) error) error {
	dir, err := root.Open(".")
	if err != nil {
		return ErrDagInvalidSource
	}
	defer dir.Close()
	for {
		entries, readErr := dir.ReadDir(activityDirectoryBatchSize)
		for _, entry := range entries {
			if filepath.Ext(entry.Name()) != ".json" || entry.Type()&os.ModeSymlink != 0 || entry.IsDir() {
				continue
			}
			data, err := readCompleteSource(ctx, root, entry.Name())
			if errors.Is(err, ErrDagNotFound) {
				continue
			}
			if err != nil {
				return err
			}
			if err := visit(data); err != nil {
				return err
			}
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if errors.Is(readErr, io.EOF) {
			return nil
		}
		if readErr != nil {
			return ErrDagInvalidSource
		}
	}
}

type dagSourceOwner struct {
	RunID           string `json:"runId"`
	ParentSessionID string `json:"parentSessionId"`
}

type dagOwnership struct {
	cwd    string
	parent string
	tasks  []storedTask
	loaded bool
}

func (o *dagOwnership) owns(ctx context.Context, header dagSourceOwner, data []byte) (bool, error) {
	if o.parent == "" {
		return false, nil
	}
	if header.ParentSessionID != "" {
		return header.ParentSessionID == o.parent, nil
	}
	if !o.loaded {
		root, err := openDagDirectory(o.cwd, ".omo", "senpi-task", "tasks")
		if errors.Is(err, errDagStoreAbsent) {
			o.loaded = true
			return false, nil
		}
		if err != nil {
			return false, err
		}
		defer root.Close()
		err = visitDagSources(ctx, root, func(data []byte) error {
			var task storedTask
			if json.Unmarshal(data, &task) != nil {
				return ErrDagInvalidSource
			}
			if task.ParentSessionID == o.parent && task.TaskID != "" && task.Owner.Kind == "dag" && task.Owner.RunID != "" {
				o.tasks = append(o.tasks, task)
			}
			return nil
		})
		if err != nil {
			return false, err
		}
		o.loaded = true
	}
	var run struct {
		Nodes []struct {
			ID     string `json:"id"`
			TaskID string `json:"taskId"`
		} `json:"nodes"`
	}
	if json.Unmarshal(data, &run) != nil {
		return false, ErrDagInvalidSource
	}
	for _, task := range o.tasks {
		if task.Owner.RunID != header.RunID {
			continue
		}
		for _, node := range run.Nodes {
			if node.TaskID == task.TaskID && node.ID != "" && (task.Owner.NodeID == "" || task.Owner.NodeID == node.ID) {
				return true, nil
			}
		}
	}
	return false, nil
}

// scanCompleteDags discovers embedded identities without treating a filename,
// replay-cache membership, or a bounded overview as an ownership index.
func scanCompleteDags(ctx context.Context, owner dagOwnership, selected string, visit func(CompleteDagDocument) error) error {
	root, err := openDagDirectory(owner.cwd, ".omo", "senpi-task", "dag", "runs")
	if err != nil {
		return err
	}
	defer root.Close()
	seen := map[string]bool{}
	return visitDagSources(ctx, root, func(data []byte) error {
		var header dagSourceOwner
		if json.Unmarshal(data, &header) != nil {
			return ErrDagInvalidSource
		}
		if selected != "" && header.RunID != selected {
			return nil
		}
		owned, err := owner.owns(ctx, header, data)
		if err != nil {
			return err
		}
		if !owned {
			return nil
		}
		document, err := parseCompleteDag(data)
		if err != nil {
			return err
		}
		if seen[document.Run.RunID] {
			return ErrDagInvalidSource
		}
		seen[document.Run.RunID] = true
		return visit(document)
	})
}

func ReadCompleteDag(ctx context.Context, cwd, parent, runID string) (CompleteDagDocument, error) {
	var result CompleteDagDocument
	err := scanCompleteDags(ctx, dagOwnership{cwd: cwd, parent: parent}, runID, func(doc CompleteDagDocument) error { result = doc; return nil })
	if errors.Is(err, errDagStoreAbsent) {
		return CompleteDagDocument{}, ErrDagNotFound
	}
	if err != nil {
		return CompleteDagDocument{}, err
	}
	if !result.Complete {
		return CompleteDagDocument{}, ErrDagNotFound
	}
	return result, nil
}

type DagCatalogEntry struct {
	RunID        string `json:"run_id"`
	RunKey       string `json:"run_key"`
	Name         string `json:"name"`
	Status       string `json:"status"`
	CreatedAt    string `json:"created_at,omitempty"`
	UpdatedAt    string `json:"updated_at,omitempty"`
	Total        int    `json:"total"`
	ContentToken string `json:"content_token"`
}

// ReadDagCatalog retains only metadata, but validates each full owned graph so
// invalid checkpoints cannot masquerade as authoritative exact catalog counts.
// There is no arbitrary candidate, byte, or selected-run scan cap.
func ReadDagCatalog(ctx context.Context, cwd, parent string) ([]DagCatalogEntry, error) {
	entries := make([]DagCatalogEntry, 0)
	err := scanCompleteDags(ctx, dagOwnership{cwd: cwd, parent: parent}, "", func(doc CompleteDagDocument) error {
		run := doc.Run
		entries = append(entries, DagCatalogEntry{RunID: run.RunID, RunKey: run.RunKey, Name: run.Name, Status: run.Status, CreatedAt: run.CreatedAt, UpdatedAt: run.UpdatedAt, Total: run.Counts.Total, ContentToken: doc.ContentToken})
		return nil
	})
	if errors.Is(err, errDagStoreAbsent) {
		return entries, nil
	}
	if err != nil {
		return nil, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].RunID < entries[j].RunID })
	return entries, nil
}
