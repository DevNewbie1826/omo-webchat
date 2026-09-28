/**
 * Client-side steer-mark bookkeeping. Observed engine behavior persists a
 * steer as a plain user-role message with no marker, so the client records the
 * steer's persisted entry identity and restores the mark
 * onto that exact occurrence after settle, resync, or reload. The request id
 * lets a rejected send remove its own record without touching another steer.
 */

import { messageText, type UiMessage } from "./chatEntries";

const STORAGE_PREFIX = "th-chat-steer:";
/** Cap on retained steer occurrences per chat: wider than any sane run. */
const MAX_MARKS_PER_CHAT = 50;
const markedMessages = new WeakMap<UiMessage, UiMessage>();

export type SteerMark = {
  readonly requestId: string;
  readonly text: string;
} & (
  | { readonly entryId: string; readonly ordinal?: never }
  | { readonly ordinal: number; readonly entryId?: never }
);

function isSteerMark(value: unknown): value is SteerMark {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record["requestId"] === "string"
    && typeof record["text"] === "string"
    && ((typeof record["entryId"] === "string" && record["entryId"].length > 0)
      || (Number.isInteger(record["ordinal"]) && (record["ordinal"] as number) > 0));
}

function readMarks(sessionId: string): readonly SteerMark[] {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_PREFIX + sessionId);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSteerMark);
  } catch {
    return [];
  }
}

function writeMarks(sessionId: string, marks: readonly SteerMark[]): void {
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + sessionId, JSON.stringify(marks));
  } catch {
    // Private modes may throw; the mark then simply does not survive reload.
  }
}

/** Record one accepted steer at its canonical user-message occurrence. */
export function recordSteerMark(sessionId: string, mark: SteerMark): void {
  const marks = readMarks(sessionId).filter((existing) => existing.requestId !== mark.requestId);
  writeMarks(sessionId, [...marks, mark].slice(-MAX_MARKS_PER_CHAT));
}

/** Drop the exact accepted occurrence when its send is later rejected. */
export function forgetSteerMark(sessionId: string, requestId: string): void {
  const marks = readMarks(sessionId);
  const remaining = marks.filter((mark) => mark.requestId !== requestId);
  if (remaining.length === marks.length) return;
  writeMarks(sessionId, remaining);
}

/** Stable steer identities for one chat, re-read on every reconciliation. */
export function steerMarks(sessionId: string): readonly SteerMark[] {
  return readMarks(sessionId);
}

/** Legacy ordinals are interpretable only with the whole branch in memory. */
export function applyEntrySteerMarks(
  sessionId: string,
  messages: readonly UiMessage[],
  rootKnown: boolean,
): readonly UiMessage[] {
  let marks = readMarks(sessionId);
  if (rootKnown) {
    const users = messages.filter(message => message.role === "user");
    let migrated = false;
    marks = marks.map(mark => {
      if (mark.entryId !== undefined) return mark;
      const message = users[mark.ordinal - 1];
      if (!message?.id || messageText(message) !== mark.text) return mark;
      migrated = true;
      return { requestId: mark.requestId, text: mark.text, entryId: message.id };
    });
    if (migrated) writeMarks(sessionId, marks);
  }
  const byId = new Map(marks.flatMap(mark => mark.entryId === undefined ? [] : [[mark.entryId, mark] as const]));
  return messages.map(message => {
    const mark = message.id === undefined ? undefined : byId.get(message.id);
    if (message.role !== "user" || mark?.text !== messageText(message) || message.customType === "steer") return message;
    let marked = markedMessages.get(message);
    if (!marked) {
      marked = { ...message, customType: "steer" };
      markedMessages.set(message, marked);
    }
    return marked;
  });
}
