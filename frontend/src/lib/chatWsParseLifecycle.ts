import type { ChatServerFrame, JsonObject } from "./chatWs";
import {
  isRecord,
  mapRecords,
  optBoolean,
  optString,
  parseResumeCandidate,
  reqBoolean,
  reqString,
  sanitizeJson,
} from "./chatWsParseFields";

type LifecycleFrameType =
  | "compaction.started"
  | "compaction.done"
  | "run.started"
  | "run.done"
  | "ack"
  | "control.result"
  | "error"
  | "notice";

/**
 * The server stamps every notice with an RFC3339Nano string (invariant 14).
 * Convert it to epoch milliseconds for the transcript merge; an absent or
 * invalid stamp stays unset so the client can stamp its own receipt time.
 */
function optAtMs(record: Record<string, unknown>): number | undefined {
  const raw = record["at"];
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(raw);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]! || hour > 23 || minute > 59 || second > 59) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Run/compaction lifecycle, acks, notices, and typed errors.
 *
 * error frames accept the resume branch candidates under both wire spellings:
 * the v2 contract name `candidates`, and the v1 continuity name
 * `branchCandidates` still used by existing fixtures. The code stays an open
 * string at the client boundary — the features terminal-error sets name
 * legacy codes the closed wire enum does not carry.
 */
export function parseLifecycleFrame(
  type: LifecycleFrameType,
  msg: Record<string, unknown>,
  sessionId: string | null,
): ChatServerFrame | null {
  switch (type) {
    case "compaction.started": {
      if (sessionId === null) return null;
      return { type: "compaction.started", sessionId };
    }
    case "compaction.done": {
      if (sessionId === null) return null;
      const error = optString(msg, "error");
      if (error === null) return null;
      return { type: "compaction.done", sessionId, ...(error !== undefined ? { error } : {}) };
    }
    case "run.started": {
      if (sessionId === null) return null;
      return { type: "run.started", sessionId };
    }
    case "run.done": {
      if (sessionId === null) return null;
      const reason = reqString(msg, "reason");
      if (reason === null) return null;
      return { type: "run.done", sessionId, reason };
    }
    case "ack": {
      const command = reqString(msg, "command");
      if (command === null) return null;
      const id = optString(msg, "id");
      const requestId = optString(msg, "requestId");
      const phase = optString(msg, "phase");
      if (id === null || requestId === null || phase === null) return null;
      return {
        type: "ack",
        ...(sessionId !== null ? { sessionId } : {}),
        command,
        ...(id !== undefined ? { id } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
        ...(phase !== undefined ? { phase } : {}),
      };
    }
    case "control.result": {
      if (sessionId === null) return null;
      const command = reqString(msg, "command");
      const success = reqBoolean(msg, "success");
      if (command === null || success === null) return null;
      const requestId = optString(msg, "requestId");
      const message = optString(msg, "message");
      if (requestId === null || message === null) return null;
      return {
        type: "control.result",
        sessionId,
        command,
        ...(requestId !== undefined ? { requestId } : {}),
        success,
        ...(message !== undefined ? { message } : {}),
      };
    }
    case "notice": {
      if (sessionId === null) return null;
      const kind = reqString(msg, "kind");
      if (kind === null || kind.length === 0) return null;
      // payload is an opaque server-side record: present-but-non-object rejects
      // the frame; a valid record is sanitized to plain JSON before it can
      // reach state or the DOM.
      const rawPayload = msg["payload"];
      if (rawPayload !== undefined && !isRecord(rawPayload)) return null;
      const at = optAtMs(msg);
      const nid = optString(msg, "nid");
      if (nid === null) return null;
      const payload = rawPayload !== undefined ? sanitizeJson(rawPayload) as JsonObject : undefined;
      return {
        type: "notice",
        sessionId,
        kind,
        ...(payload !== undefined ? { payload } : {}),
        ...(at !== undefined ? { at } : {}),
        ...(nid !== undefined && nid.length > 0 ? { nid } : {}),
      };
    }
    case "error": {
      const message = reqString(msg, "message");
      if (message === null) return null;
      const code = optString(msg, "code");
      const command = optString(msg, "command");
      const requestId = optString(msg, "requestId");
      const dangling = optBoolean(msg, "dangling");
      const knownLeaf = optString(msg, "knownLeaf");
      const observedLeaf = optString(msg, "observedLeaf");
      // Optional resume branch candidates; any malformed entry rejects the
      // whole frame so a half-parsed list never reaches the UI.
      const rawCandidates = msg["candidates"] ?? msg["branchCandidates"];
      const candidates = rawCandidates === undefined ? undefined : mapRecords(rawCandidates, parseResumeCandidate);
      if (code === null || command === null || requestId === null || dangling === null || knownLeaf === null || observedLeaf === null || candidates === null) return null;
      return {
        type: "error",
        ...(sessionId !== null ? { sessionId } : {}),
        ...(code !== undefined ? { code } : {}),
        ...(command !== undefined ? { command } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
        ...(dangling !== undefined ? { dangling } : {}),
        ...(candidates !== undefined ? { candidates } : {}),
        ...(knownLeaf !== undefined ? { knownLeaf } : {}),
        ...(observedLeaf !== undefined ? { observedLeaf } : {}),
        message,
      };
    }
  }
}
