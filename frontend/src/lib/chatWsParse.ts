import type { ChatServerFrame } from "./chatWs";
import { parseConversationFrame } from "./chatWsParseConversation";
import { isRecord, reqString } from "./chatWsParseFields";
import { parseLifecycleFrame } from "./chatWsParseLifecycle";
import { parseSessionFrame } from "./chatWsParseSession";

export { sanitizeJson } from "./chatWsParseFields";

/**
 * Type-specific parse boundary for inbound server frames. Rejects unknown types
 * and any frame whose UI-dereferenced fields are missing or malformed, returning
 * null so a stale or hostile frame is dropped instead of mutating chat state.
 * Each frame is rebuilt field-by-field rather than cast; nested structures are
 * validated by the parsers in chatWsParseFields.
 */

const SERVER_FRAME_TYPES: ReadonlySet<string> = new Set([
  "ready",
  "chat.name",
  "messageDelta",
  "message",
  "tool",
  "state",
  "stats",
  "extensionEvent",
  "approval",
  "commands",
  "models",
  "entries",
  "compaction.started",
  "compaction.done",
  "run.started",
  "run.done",
  "ack",
  "control.result",
  "error",
]);

export function parseChatServerFrame(msg: unknown): ChatServerFrame | null {
  if (!isRecord(msg)) return null;
  const type = msg["type"];
  if (typeof type !== "string" || !SERVER_FRAME_TYPES.has(type)) return null;
  // ack/error may omit sessionId; every other frame is session-scoped.
  const sessionOptional = type === "ack" || type === "error";
  const sessionId = reqString(msg, "sessionId");
  if (!sessionOptional && sessionId === null) return null;
  switch (type) {
    case "ready":
    case "chat.name":
    case "messageDelta":
    case "message":
    case "tool":
      return parseConversationFrame(type, msg, sessionId);
    case "state":
    case "stats":
    case "extensionEvent":
    case "approval":
    case "commands":
    case "models":
    case "entries":
      return parseSessionFrame(type, msg, sessionId);
    case "compaction.started":
    case "compaction.done":
    case "run.started":
    case "run.done":
    case "ack":
    case "control.result":
    case "error":
      return parseLifecycleFrame(type, msg, sessionId);
    default:
      return null;
  }
}
