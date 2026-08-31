import { connectWs } from "./ws";
import type { WsHandlers } from "./ws";
import { notifyUnauthorized } from "./api";
import { sessionExpired } from "../features/auth/auth";
import { parseChatServerFrame } from "./chatWsParse";

export { parseChatServerFrame, sanitizeJson } from "./chatWsParse";

type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

export interface ContextUsage {
  readonly tokens: number;
  readonly contextWindow: number;
  readonly percent: number;
}

export interface ToolPayload {
  readonly content?: readonly { readonly text?: string }[];
  readonly details?: JsonValue;
}

export interface AssistantDelta {
  readonly kind: string;
  readonly contentIndex?: number;
  readonly delta?: string;
  readonly content?: string;
  readonly reason?: string;
  readonly partial?: unknown;
}

export interface ContentBlock {
  readonly kind: string;
  readonly text?: string;
  readonly thinking?: string;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: unknown;
  readonly isError?: boolean;
}

export interface AssistantMessage {
  readonly role: string;
  readonly customType?: string;
  readonly blocks?: readonly ContentBlock[];
  readonly model?: string;
  readonly usage?: unknown;
  readonly ts?: number;
}

/**
 * Provider RPC command echoed on an error frame. The backend forwards the
 * provider's raw command string (prompt, steer, follow_up, set_model,
 * set_thinking_level, get_state, get_session_stats, get_commands,
 * get_available_models, get_entries, new_session, switch_session, compact,
 * extension_ui_response), so the parse boundary stays an open string; the
 * frontend only branches on "prompt".
 */
export type FailedRpcCommand = string;

/**
 * A sibling provider branch that may hold the lost conversation, surfaced on
 * a resume_failed error frame when the stored identity no longer resolves.
 */
export interface ResumeCandidate {
  readonly id: string;
  readonly name: string;
  readonly hostPath?: string;
}

/** Where a discovered command came from, per Omo's get_commands contract. */
export interface CommandSourceInfo {
  readonly path?: string;
  readonly baseDir?: string;
  readonly source?: string;
  readonly scope?: string;
  readonly origin?: string;
}

export interface CommandEntry {
  readonly name: string;
  readonly description?: string;
  readonly source?: string;
  /** How the command is invoked ("slash" for palette commands). */
  readonly syntax?: string;
  readonly sourceInfo?: CommandSourceInfo;
}

export type ChatServerFrame =
  | { readonly type: "ready"; readonly sessionId: string; readonly piSessionId: string | null; readonly resumed: boolean }
  | { readonly type: "chat.name"; readonly sessionId: string; readonly name: string; readonly origin: "auto" | "provider" }
  | { readonly type: "messageDelta"; readonly sessionId: string; readonly messageId?: string; readonly delta: AssistantDelta }
  | { readonly type: "message"; readonly sessionId: string; readonly message: AssistantMessage }
  | { readonly type: "tool"; readonly sessionId: string; readonly toolCallId: string; readonly toolName: string; readonly phase: "start" | "update" | "end"; readonly args?: JsonValue; readonly partial?: ToolPayload; readonly result?: ToolPayload; readonly isError?: boolean }
  | { readonly type: "state"; readonly sessionId: string; readonly isStreaming: boolean; readonly isCompacting: boolean; readonly thinkingLevel?: string; readonly model?: { readonly provider: string; readonly modelId: string } | null; readonly sessionName?: string }
  | { readonly type: "stats"; readonly sessionId: string; readonly cost?: number; readonly contextUsage?: ContextUsage; readonly tokens?: JsonValue }
  | { readonly type: "extensionEvent"; readonly sessionId: string; readonly name: string; readonly data?: JsonValue }
  | { readonly type: "approval"; readonly sessionId: string; readonly id: string; readonly method: "select" | "confirm" | "input" | "editor"; readonly title?: string; readonly message?: string; readonly options?: readonly string[]; readonly prefill?: string; readonly placeholder?: string }
  | { readonly type: "commands"; readonly sessionId: string; readonly commands: readonly CommandEntry[] }
  | { readonly type: "models"; readonly sessionId: string; readonly models: readonly { readonly provider: string; readonly modelId: string; readonly name?: string; readonly input?: readonly string[] }[] }
  | { readonly type: "entries"; readonly sessionId: string; readonly entries: unknown; readonly leafId?: string; readonly final?: boolean }
  | { readonly type: "compaction.started"; readonly sessionId: string }
  | { readonly type: "compaction.done"; readonly sessionId: string; readonly error?: string }
  | { readonly type: "run.started"; readonly sessionId: string }
  | { readonly type: "run.done"; readonly sessionId: string; readonly reason: string }
  | { readonly type: "ack"; readonly sessionId?: string; readonly command: string; readonly id?: string; readonly requestId?: string }
  | { readonly type: "control.result"; readonly sessionId: string; readonly command: string; readonly requestId?: string; readonly success: boolean; readonly message?: string }
  | { readonly type: "error"; readonly sessionId?: string; readonly code?: string; readonly command?: FailedRpcCommand; readonly requestId?: string; readonly dangling?: boolean; readonly candidates?: readonly ResumeCandidate[]; readonly message: string };

export interface ChatImage {
  readonly data: string;
  readonly mimeType: string;
}

export type ChatClientFrame =
  | { readonly type: "chat.create"; readonly wsId: string; readonly chatId: string }
  | { readonly type: "chat.send"; readonly sessionId: string; readonly run: { readonly kind: "prompt" | "steer" | "follow_up"; readonly message: string; readonly images?: readonly ChatImage[] } }
  | { readonly type: "chat.abort"; readonly sessionId: string }
  | { readonly type: "chat.close"; readonly sessionId: string }
  | { readonly type: "chat.disconnect"; readonly sessionId: string }
  | { readonly type: "chat.set"; readonly sessionId: string; readonly requestId?: string; readonly model?: { readonly provider: string; readonly modelId: string }; readonly thinkingLevel?: string }
  | { readonly type: "approval.respond"; readonly sessionId: string; readonly requestId?: string; readonly id: string; readonly value?: string; readonly confirmed?: boolean; readonly cancelled?: boolean }
  | { readonly type: "chat.commands"; readonly sessionId: string }
  | { readonly type: "chat.compact"; readonly sessionId: string }
  | { readonly type: "chat.models"; readonly sessionId: string }
  | { readonly type: "chat.stats"; readonly sessionId: string }
  | { readonly type: "activity.refresh"; readonly sessionId: string }
  | { readonly type: "chat.resume"; readonly sessionId: string; readonly since?: string };

export interface ChatClient {
  readonly send: (msg: ChatClientFrame) => boolean;
  readonly close: () => void;
}

export interface ChatHandlers {
  readonly onOpen?: () => void;
  readonly onFrame: (frame: ChatServerFrame) => void;
  readonly onParseError?: (raw: string) => void;
  readonly onClose?: (code: number) => void;
}

export type ChatConnector = (handlers: ChatHandlers) => ChatClient;

export const connectChat: ChatConnector = (handlers) => {
  const wsHandlers: WsHandlers = {
    onMessage: (msg) => {
      const frame = parseChatServerFrame(msg);
      if (frame) handlers.onFrame(frame);
    },
    ...(handlers.onOpen ? { onOpen: handlers.onOpen } : {}),
    ...(handlers.onParseError ? { onParseError: handlers.onParseError } : {}),
    ...(handlers.onClose ? { onClose: handlers.onClose } : {}),
  };
  const conn = connectWs("/api/ws", wsHandlers, {
    // The websocket never sees the HTTP status of a refused upgrade: a socket
    // that closes without ever opening is the likely expired-session signal.
    // Confirm with a REST auth probe — on 401 send the SPA to the login page
    // and stop reconnecting; any other verdict keeps the normal backoff.
    onUpgradeFailure: async () => {
      const expired = await sessionExpired();
      if (expired) notifyUnauthorized();
      return !expired;
    },
  });
  return {
    send: (m) => conn.send(m),
    close: () => conn.close(),
  };
};
