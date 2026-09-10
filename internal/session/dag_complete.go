package session

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"unicode/utf8"
)

var (
	ErrDagNotFound      = errors.New("DAG run not found")
	ErrDagSourceChanged = errors.New("DAG source changed during read")
	ErrDagInvalidSource = errors.New("invalid DAG checkpoint")
)

// CompleteDagDocument is independent of the bounded activity/replay projection.
// ContentToken compares original source bytes for equality; it is not a clock.
type CompleteDagDocument struct {
	Complete     bool       `json:"complete"`
	ContentToken string     `json:"content_token"`
	Run          FullDagRun `json:"run"`
}

type FullDagRun struct {
	RunID     string            `json:"run_id"`
	RunKey    string            `json:"run_key"`
	Name      string            `json:"name"`
	Status    string            `json:"status"`
	CreatedAt string            `json:"created_at,omitempty"`
	UpdatedAt string            `json:"updated_at,omitempty"`
	Counts    FullDagCounts     `json:"counts"`
	Nodes     []FullDagNode     `json:"nodes"`
	Edges     []activityDagEdge `json:"edges"`
	Waves     []activityDagWave `json:"waves"`
}

type FullDagCounts struct {
	Total     int `json:"total"`
	Pending   int `json:"pending"`
	Blocked   int `json:"blocked"`
	Scheduled int `json:"scheduled"`
	Running   int `json:"running"`
	Completed int `json:"completed"`
	Failed    int `json:"failed"`
	Cancelled int `json:"cancelled"`
	Skipped   int `json:"skipped"`
}

type FullDagNode struct {
	ID          string   `json:"id"`
	Label       string   `json:"label,omitempty"`
	Prompt      string   `json:"prompt"`
	DependsOn   []string `json:"depends_on"`
	State       string   `json:"state"`
	TaskID      string   `json:"task_id,omitempty"`
	Attempt     *int     `json:"attempt,omitempty"`
	StartedAt   string   `json:"started_at,omitempty"`
	CompletedAt string   `json:"completed_at,omitempty"`
}

// Pointers distinguish missing required fields from valid empty descriptions
// and absent attempt metadata from the original zero attempt.
type completeStoredNode struct {
	ID          string  `json:"id"`
	Label       string  `json:"label"`
	Prompt      *string `json:"prompt"`
	State       string  `json:"state"`
	TaskID      string  `json:"taskId"`
	Attempt     *int    `json:"attempt"`
	StartedAt   string  `json:"startedAt"`
	CompletedAt string  `json:"completedAt"`
}

type completeStoredDefinition struct {
	ID        string   `json:"id"`
	Label     string   `json:"label"`
	Prompt    *string  `json:"prompt"`
	DependsOn []string `json:"dependsOn"`
}

type completeStoredRun struct {
	RunID      string `json:"runId"`
	RunKey     string `json:"runKey"`
	Name       string `json:"name"`
	Status     string `json:"status"`
	CreatedAt  string `json:"createdAt"`
	UpdatedAt  string `json:"updatedAt"`
	Definition struct {
		Nodes []completeStoredDefinition `json:"nodes"`
	} `json:"definition"`
	Nodes []completeStoredNode `json:"nodes"`
	// Waves stays raw: a malformed optional hint must degrade to the computed
	// layout in storedDagWaves, never fail the checkpoint decode itself.
	Waves json.RawMessage `json:"waves"`
}

type completeStoredWave struct {
	Index   *int64   `json:"index"`
	NodeIDs []string `json:"nodeIds"`
}

// dagWaveMaxSafeIndex is the frontend's Number.isSafeInteger ceiling: a
// larger lane index would make the browser-side complete-document parser
// reject the whole response, so such hints are unusable and fall back.
const dagWaveMaxSafeIndex = int64(9007199254740991)

// Stored waves are the engine's authored layout: the lane assignment and
// the deliberate order inside each lane. They pass through verbatim only
// when the hint decodes, every wave carries a present, non-null, distinct
// index in the frontend-safe range, and the waves cover every node exactly
// once; anything less trustworthy — including malformed hint shapes, which
// are decoded independently so they cannot invalidate the checkpoint —
// falls back to the computed layout instead of painting a broken arrangement.
func storedDagWaves(raw json.RawMessage, nodes []activityDagNode) []activityDagWave {
	var stored []completeStoredWave
	if len(raw) == 0 || string(raw) == "null" || json.Unmarshal(raw, &stored) != nil {
		return dagWaves(nodes)
	}
	if len(stored) == 0 {
		return dagWaves(nodes)
	}
	known := make(map[string]bool, len(nodes))
	for _, node := range nodes {
		known[node.ID] = true
	}
	indices := make(map[int64]bool, len(stored))
	covered := make(map[string]bool, len(nodes))
	waves := make([]activityDagWave, 0, len(stored))
	for _, wave := range stored {
		if len(wave.NodeIDs) == 0 || wave.Index == nil || *wave.Index < 0 || *wave.Index > dagWaveMaxSafeIndex || indices[*wave.Index] {
			return dagWaves(nodes)
		}
		indices[*wave.Index] = true
		for _, id := range wave.NodeIDs {
			if !known[id] || covered[id] {
				return dagWaves(nodes)
			}
			covered[id] = true
		}
		waves = append(waves, activityDagWave{Index: int(*wave.Index), NodeIDs: append([]string(nil), wave.NodeIDs...)})
	}
	if len(covered) != len(nodes) {
		return dagWaves(nodes)
	}
	sort.SliceStable(waves, func(i, j int) bool { return waves[i].Index < waves[j].Index })
	return waves
}

func parseCompleteDag(data []byte) (CompleteDagDocument, error) {
	var stored completeStoredRun
	if !utf8.Valid(data) || json.Unmarshal(data, &stored) != nil || stored.RunID == "" || stored.Status == "" || stored.Nodes == nil || stored.Definition.Nodes == nil || len(stored.Nodes) != len(stored.Definition.Nodes) {
		return CompleteDagDocument{}, ErrDagInvalidSource
	}
	definitions := make(map[string]completeStoredDefinition, len(stored.Definition.Nodes))
	for _, def := range stored.Definition.Nodes {
		if def.ID == "" {
			return CompleteDagDocument{}, ErrDagInvalidSource
		}
		if _, exists := definitions[def.ID]; exists {
			return CompleteDagDocument{}, ErrDagInvalidSource
		}
		definitions[def.ID] = def
	}
	run := FullDagRun{RunID: stored.RunID, RunKey: stored.RunKey, Name: stored.Name, Status: stored.Status, CreatedAt: stored.CreatedAt, UpdatedAt: stored.UpdatedAt, Nodes: make([]FullDagNode, 0, len(stored.Nodes)), Edges: make([]activityDagEdge, 0), Counts: FullDagCounts{Total: len(stored.Nodes)}}
	seen := make(map[string]bool, len(stored.Nodes))
	waveNodes := make([]activityDagNode, 0, len(stored.Nodes))
	for _, node := range stored.Nodes {
		def, exists := definitions[node.ID]
		if !exists || seen[node.ID] || (node.Attempt != nil && *node.Attempt < 0) {
			return CompleteDagDocument{}, ErrDagInvalidSource
		}
		seen[node.ID] = true
		prompt := node.Prompt
		if prompt == nil || *prompt == "" {
			prompt = def.Prompt
		}
		if prompt == nil {
			return CompleteDagDocument{}, ErrDagInvalidSource
		}
		label := node.Label
		if label == "" {
			label = def.Label
		}
		depends := def.DependsOn
		if depends == nil {
			depends = []string{}
		}
		for _, dep := range depends {
			if _, ok := definitions[dep]; !ok {
				return CompleteDagDocument{}, ErrDagInvalidSource
			}
			run.Edges = append(run.Edges, activityDagEdge{From: dep, To: node.ID})
		}
		switch node.State {
		case "pending":
			run.Counts.Pending++
		case "blocked":
			run.Counts.Blocked++
		case "scheduled":
			run.Counts.Scheduled++
		case "running":
			run.Counts.Running++
		case "completed":
			run.Counts.Completed++
		case "failed":
			run.Counts.Failed++
		case "cancelled":
			run.Counts.Cancelled++
		case "skipped":
			run.Counts.Skipped++
		default:
			return CompleteDagDocument{}, ErrDagInvalidSource
		}
		run.Nodes = append(run.Nodes, FullDagNode{ID: node.ID, Label: label, Prompt: *prompt, DependsOn: depends, State: node.State, TaskID: node.TaskID, Attempt: node.Attempt, StartedAt: node.StartedAt, CompletedAt: node.CompletedAt})
		waveNodes = append(waveNodes, activityDagNode{ID: node.ID, DependsOn: depends})
	}
	run.Waves = storedDagWaves(stored.Waves, waveNodes)
	sum := sha256.Sum256(data)
	return CompleteDagDocument{Complete: true, ContentToken: hex.EncodeToString(sum[:]), Run: run}, nil
}
