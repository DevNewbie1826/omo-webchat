import type { ChatServerFrame } from "./chatWs";
import {
  isRecord,
  optBoolean,
  optString,
  parseAssistantDelta,
  parseAssistantMessage,
  parseToolPayload,
  reqBoolean,
  reqString,
  sanitizeJson,
} from "./chatWsParseFields";

type ConversationFrameType = "ready" | "chat.name" | "messageDelta" | "message" | "tool";

export function parseConversationFrame(
  type: ConversationFrameType,
  msg: Record<string, unknown>,
  sessionId: string | null,
): ChatServerFrame | null {
  switch (type) {
    case "ready": {
      if (sessionId === null) return null;
      const piSessionId = msg["piSessionId"];
      if (typeof piSessionId !== "string" && piSessionId !== null) return null;
      const resumed = reqBoolean(msg, "resumed");
      if (resumed === null) return null;
      return { type: "ready", sessionId, piSessionId, resumed };
    }
    case "chat.name": {
      if (sessionId === null) return null;
      const name = reqString(msg, "name");
      if (name === null) return null;
      const origin = optString(msg, "origin");
      if (origin === null) return null;
      if (origin !== undefined && origin !== "auto" && origin !== "provider") return null;
      return {
        type: "chat.name",
        sessionId,
        name,
        origin: origin ?? "auto",
      };
    }
    case "messageDelta": {
      if (sessionId === null) return null;
      const delta = isRecord(msg["delta"]) ? parseAssistantDelta(msg["delta"]) : null;
      if (delta === null) return null;
      const messageId = optString(msg, "messageId");
      if (messageId === null) return null;
      return { type: "messageDelta", sessionId, ...(messageId !== undefined ? { messageId } : {}), delta };
    }
    case "message": {
      if (sessionId === null) return null;
      const message = isRecord(msg["message"]) ? parseAssistantMessage(msg["message"]) : null;
      if (message === null) return null;
      return { type: "message", sessionId, message };
    }
    case "tool": {
      if (sessionId === null) return null;
      const toolCallId = reqString(msg, "toolCallId");
      const toolName = reqString(msg, "toolName");
      const phase = msg["phase"];
      if (toolCallId === null || toolName === null) return null;
      if (phase !== "start" && phase !== "update" && phase !== "end") return null;
      const partial = parseToolPayload(msg["partial"]);
      const result = parseToolPayload(msg["result"]);
      const isError = optBoolean(msg, "isError");
      const args = msg["args"];
      if (partial === null || result === null || isError === null) return null;
      return {
        type: "tool",
        sessionId,
        toolCallId,
        toolName,
        phase,
        ...(args !== undefined ? { args: sanitizeJson(args) } : {}),
        ...(partial !== undefined ? { partial } : {}),
        ...(result !== undefined ? { result } : {}),
        ...(isError !== undefined ? { isError } : {}),
      };
    }
  }
}
