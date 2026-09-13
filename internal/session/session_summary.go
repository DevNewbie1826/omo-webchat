package session

import (
	"encoding/json"
	"time"
)

type Summary struct {
	ChatID            string
	DurableSessionID  string
	ReplacesSessionID string
	SessionFile       string
	CWD               string
	Active            bool
	Attachments       int
	Title             string
	ActivityPair      ActivityPair
	TaskOversized     bool
	DagOversized      bool
	TaskDigest        *TaskDigest
	DagDigest         *DagDigest
	live              *LiveValues
}

func (s *Session) summaryLocked() Summary {
	snapshot := Summary{
		ChatID: s.chatID, DurableSessionID: s.durableID, SessionFile: s.sessionFile,
		CWD: s.cwd, Active: s.activeLocked(), Attachments: s.broadcast.count(), Title: s.title,
		ActivityPair: ActivityPair{
			Task: append(json.RawMessage(nil), s.activitySnapshots[activitySnapshotOrder[0]]...),
			Dag:  append(json.RawMessage(nil), s.activitySnapshots[activitySnapshotOrder[1]]...),
		},
		TaskOversized: s.activityOversized[activitySnapshotOrder[0]],
		DagOversized:  s.activityOversized[activitySnapshotOrder[1]],
		TaskDigest:    cloneTaskDigest(s.taskDigest),
		DagDigest:     cloneDagDigest(s.dagDigest),
	}
	return s.liveRevision.project(snapshot, time.Now().UnixMilli())
}

func (entry *overviewCacheEntry) summary(chatID, durableID string) Summary {
	snapshot := Summary{
		ChatID: chatID, DurableSessionID: durableID,
		ActivityPair: ActivityPair{
			Task: append(json.RawMessage(nil), entry.snapshots[activitySnapshotOrder[0]]...),
			Dag:  append(json.RawMessage(nil), entry.snapshots[activitySnapshotOrder[1]]...),
		},
		TaskOversized: entry.oversized[activitySnapshotOrder[0]],
		DagOversized:  entry.oversized[activitySnapshotOrder[1]],
		TaskDigest:    cloneTaskDigest(entry.task),
		DagDigest:     cloneDagDigest(entry.dag),
	}
	return entry.liveRevision.project(snapshot, time.Now().UnixMilli())
}
