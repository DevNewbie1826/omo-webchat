package api

import "github.com/DevNewbie1826/omo-webchat/internal/cursorstore"

// chatRecencyMs combines use with represented-file activity before considering
// creation. A newer wrapper's creation is not activity of the logical session.
func chatRecencyMs(ch cursorstore.Chat, disk []diskSession) int64 {
	recency := max(int64(0), cursorstore.RecencyMillis(cursorstore.Chat{LastUsedAt: ch.LastUsedAt}))
	fallback := max(int64(0), cursorstore.RecencyMillis(cursorstore.Chat{CreatedAt: ch.CreatedAt}))
	incorporate := func(sess diskSession) {
		if !sessionMatchesChat(sess, ch) {
			return
		}
		recency = max(recency, sess.ModTime.UnixMilli())
		fallback = max(fallback, sess.RecencyMs)
	}
	if sess, ok := parseSessionFile(ch.SessionFile); ok {
		incorporate(sess)
	}
	for _, sess := range disk {
		incorporate(sess)
	}
	if recency > 0 {
		return recency
	}
	return fallback
}
