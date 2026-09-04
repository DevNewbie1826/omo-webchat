/**
 * Client-side steer-mark bookkeeping, keyed by chat and text. The steer mark
 * is UI presentation, not engine data: observed engine behavior persists a
 * steer as a plain user-role message with no marker, so the transcript mark
 * must be re-derived by the client across run settle, manual resync, and a
 * full page reload. This store persists the texts of accepted steers per
 * chat (sessionStorage, tolerating storage failure with an in-memory
 * fallback) so the history reconciliation can re-tag the canonical plain
 * flush with the steer mark. Occurrences are counted, never consumed by
 * rendering, so every reload derives identical marks; a rejected steer
 * forgets its occurrence so a never-persisted text cannot mis-mark a later
 * identical prompt.
 */

const STORAGE_PREFIX = "th-chat-steer:";
/** Cap on retained steer texts per chat: wider than any sane run. */
const MAX_TEXTS_PER_CHAT = 50;

function readTexts(sessionId: string): readonly string[] {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_PREFIX + sessionId);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((text): text is string => typeof text === "string");
  } catch {
    return [];
  }
}

function writeTexts(sessionId: string, texts: readonly string[]): void {
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + sessionId, JSON.stringify(texts));
  } catch {
    // Private modes may throw; the mark then simply does not survive a
    // reload, matching the degraded storage the rest of the app tolerates.
  }
}

/** Record one accepted steer occurrence for the chat. */
export function recordSteerMark(sessionId: string, text: string): void {
  const texts = readTexts(sessionId);
  writeTexts(sessionId, [...texts, text].slice(-MAX_TEXTS_PER_CHAT));
}

/** Drop one occurrence (earliest first) when a steer provably never persisted. */
export function forgetSteerMark(sessionId: string, text: string): void {
  const texts = readTexts(sessionId);
  const index = texts.indexOf(text);
  if (index < 0) return;
  writeTexts(sessionId, [...texts.slice(0, index), ...texts.slice(index + 1)]);
}

/** Occurrence counts per steer text for one chat: text -> remaining marks. */
export function steerMarkCounts(sessionId: string): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const text of readTexts(sessionId)) {
    counts[text] = (counts[text] ?? 0) + 1;
  }
  return counts;
}
