package session

import "reflect"

// liveRevision is owned under the session lifecycle lock or overview manager
// lock. It remembers only rendered scalars, never raw activity inventories.
type liveRevision struct {
	values       LiveValues
	active       bool
	title        string
	initialized  bool
	progressSeen bool
}

func (r *liveRevision) project(summary Summary, now int64) Summary {
	values := summary.LiveValues()
	receipt := values.LastActivityMS
	values.LastActivityMS = nil
	if values.LastLine != nil {
		r.progressSeen = true
	} else if summary.TaskDigest != nil && r.progressSeen {
		empty := ""
		values.LastLine = &empty
	}
	previous := r.values
	previous.LastActivityMS = nil
	changed := !r.initialized || r.active != summary.Active || r.title != summary.Title || !reflect.DeepEqual(previous, values)
	if changed {
		if receipt != nil {
			now = max(now, *receipt)
		}
		if r.values.LastActivityMS != nil {
			now = max(now, *r.values.LastActivityMS+1)
		}
		// Preserve omission for a first, lifecycle-only inactive row.
		if r.initialized || receipt != nil || summary.Active {
			revision := min(maxLiveInteger, now)
			values.LastActivityMS = &revision
		}
		r.values, r.active, r.title, r.initialized = values, summary.Active, summary.Title, true
	}
	projected := r.values
	summary.live = &projected
	return summary
}
