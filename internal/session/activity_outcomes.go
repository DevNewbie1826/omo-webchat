package session

import "encoding/json"

type dagTaskOutcome struct {
	status   string
	fromNode bool
}

func terminalDagRunTaskOutcomes(dag json.RawMessage) map[string]dagTaskOutcome {
	if len(dag) == 0 {
		return nil
	}
	var doc struct {
		Runs []struct {
			Status string `json:"status"`
			Nodes  []struct {
				TaskID string `json:"task_id"`
				State  string `json:"state"`
			} `json:"nodes"`
		} `json:"runs"`
	}
	if json.Unmarshal(dag, &doc) != nil {
		return nil
	}
	var outcomes map[string]dagTaskOutcome
	for _, run := range doc.Runs {
		if !terminalDagStatuses[run.Status] {
			continue
		}
		for _, node := range run.Nodes {
			if node.TaskID == "" {
				continue
			}
			outcome := dagTaskOutcome{status: run.Status}
			if terminalTaskStatuses[node.State] {
				outcome = dagTaskOutcome{status: node.State, fromNode: true}
			}
			if previous, exists := outcomes[node.TaskID]; exists && previous.fromNode && !outcome.fromNode {
				continue
			}
			if outcomes == nil {
				outcomes = make(map[string]dagTaskOutcome)
			}
			outcomes[node.TaskID] = outcome
		}
	}
	return outcomes
}
