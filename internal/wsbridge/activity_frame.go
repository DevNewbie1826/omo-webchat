package wsbridge

import (
	"encoding/json"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

func cloneActivitySummary(summary session.Summary) session.Summary {
	summary.ActivityPair.Task = append(json.RawMessage(nil), summary.ActivityPair.Task...)
	summary.ActivityPair.Dag = append(json.RawMessage(nil), summary.ActivityPair.Dag...)
	if summary.TaskDigest != nil {
		copyDigest := *summary.TaskDigest
		copyDigest.Tasks = append([]session.TaskDigestEntry(nil), summary.TaskDigest.Tasks...)
		summary.TaskDigest = &copyDigest
	}
	if summary.DagDigest != nil {
		copyDigest := *summary.DagDigest
		copyDigest.Runs = make([]session.RunDigestEntry, len(summary.DagDigest.Runs))
		for i, run := range summary.DagDigest.Runs {
			copyDigest.Runs[i] = run
			copyDigest.Runs[i].RunningTaskIDs = append([]string(nil), run.RunningTaskIDs...)
		}
		summary.DagDigest = &copyDigest
	}
	return summary
}

func activityFrame(summary session.Summary, overflow bool) wscontract.SessionsActivityFrame {
	lean := summary.LiveValues()
	frame := wscontract.SessionsActivityFrame{
		Type: "sessions.activity", SessionID: summary.ChatID, DurableSessionID: summary.DurableSessionID,
		ID: &summary.ChatID, Title: &summary.Title, Overflow: overflow, Active: &summary.Active,
		LastActivityMs: lean.LastActivityMS, LastLine: lean.LastLine,
		Running: &wscontract.SessionsActivityFrameRunning{Agents: &lean.Running.Agents, Tasks: &lean.Running.Tasks, Dag: &lean.Running.Dag},
		Done:    &lean.Done, DagDone: &lean.DagDone, DagTotal: &lean.DagTotal,
		Truncated: &wscontract.SessionsActivityFrameTruncated{Task: &lean.Truncated.Task, Dag: &lean.Truncated.Dag},
	}
	if summary.ReplacesSessionID != "" {
		frame.ReplacesSessionID = &summary.ReplacesSessionID
	}
	return frame
}
