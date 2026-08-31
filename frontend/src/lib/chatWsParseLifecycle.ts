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
 * The server stamps every notice with an RFC3339Nano string. Convert it to
 * epoch milliseconds for the transcript merge; an absent or invalid stamp
 * stays unset so the client can stamp its own receipt time instead.
 */
function optAtMs(record: Record<string, unknown>): number | undefined {
  const raw = record["at"];
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

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
      if (id === null || requestId === null) return null;
      return {
        type: "ack",
        ...(sessionId !== null ? { sessionId } : {}),
        command,
        ...(id !== undefined ? { id } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
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
      const payload = rawPayload !== undefined ? sanitizeJson(rawPayload) as JsonObject : undefined;
      const rawAt = msg["at"];
      const serverIdentity = at !== undefined && typeof rawAt === "string"
        ? `${kind}\u0000${rawAt}\u0000${JSON.stringify(payload ?? null)}`
        : undefined;
      return {
        type: "notice",
        sessionId,
        kind,
        ...(payload !== undefined ? { payload } : {}),
        ...(at !== undefined ? { at } : {}),
        ...(serverIdentity !== undefined ? { serverIdentity } : {}),
      };
    }
    case "error": {
      const message = reqString(msg, "message");
      if (message === null) return null;
      const code = optString(msg, "code");
      const command = optString(msg, "command");
      const requestId = optString(msg, "requestId");
      const dangling = optBoolean(msg, "dangling");
      // Optional resume branch candidates; any malformed entry rejects the
      // whole frame so a half-parsed list never reaches the UI.
      const rawCandidates = msg["branchCandidates"];
      const candidates = rawCandidates === undefined ? undefined : mapRecords(rawCandidates, parseResumeCandidate);
      if (code === null || command === null || requestId === null || dangling === null || candidates === null) return null;
      return {
        type: "error",
        ...(sessionId !== null ? { sessionId } : {}),
        ...(code !== undefined ? { code } : {}),
        ...(command !== undefined ? { command } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
        ...(dangling !== undefined ? { dangling } : {}),
        ...(candidates !== undefined ? { candidates } : {}),
        message,
      };
    }
  }
}
