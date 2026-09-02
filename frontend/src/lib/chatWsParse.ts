import type { ChatServerFrame } from "./chatWs";
import { parseConversationFrame } from "./chatWsParseConversation";
import { isRecord, reqString } from "./chatWsParseFields";
import { parseLifecycleFrame } from "./chatWsParseLifecycle";
import { parseSessionFrame } from "./chatWsParseSession";
import { SERVER_FRAME_TYPES } from "./contract/types_gen";

export { sanitizeJson } from "./chatWsParseFields";

/**
 * Type-specific parse boundary for inbound server frames, driven by the
 * generated contract's closed server type set. Rejects unknown types and any
 * frame whose UI-dereferenced fields are missing or malformed, returning null
 * so a stale or hostile frame is dropped instead of mutating chat state (R1:
 * unknown frames are forward-compatible and dropped silently, never an error).
 * Each frame is rebuilt field-by-field rather than cast; nested structures are
 * validated by the parsers in chatWsParseFields.
 *
 * `hello` is intentionally NOT parseable here: it is the connector's version
 * handshake frame, consumed by chatWs before the session stream starts.
 */

const SESSION_FRAME_TYPES: ReadonlySet<string> = new Set(
  SERVER_FRAME_TYPES.filter((type) => type !== "hello"),
);

export function parseChatServerFrame(msg: unknown): ChatServerFrame | null {
  if (!isRecord(msg)) return null;
  const type = msg["type"];
  if (typeof type !== "string" || !SESSION_FRAME_TYPES.has(type)) return null;
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
    case "notice":
      return parseLifecycleFrame(type, msg, sessionId);
    default:
      return null;
  }
}
