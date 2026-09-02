import { connectWs } from "./ws";
import type { WsHandlers } from "./ws";
import { notifyUnauthorized } from "./api";
import { sessionExpired } from "../features/auth/auth";
import { parseChatServerFrame } from "./chatWsParse";
import { sanitizeJson } from "./chatWsParseFields";
import { frameTypeOf, parseServerFrame } from "./contract/types_gen";
import type * as ct from "./contract/types_gen";

export { parseChatServerFrame, sanitizeJson } from "./chatWsParse";

/**
 * The features/ import seam, rewritten on the generated contract
 * (lib/contract/types_gen.ts). Shared JSON and UI types are re-exported from
 * the generated source directly; the server/client unions are assembled from
 * the generated members, with a handful of explicitly documented seam
 * adapters where the client-side shape is pinned by unmodifiable features code
 * or by a parse-boundary conversion.
 */

// Shared JSON + UI types (generated contract, single source).
export type JsonValue = ct.JsonValue;
export type JsonObject = ct.JsonObject;
export type AssistantDelta = ct.AssistantDelta;
export type AssistantMessage = AssistantMessageSeam;
export type ContentBlock = ContentBlockSeam;
export type ContextUsage = ct.ContextUsage;
export type ToolPayload = ct.ToolPayload;
export type ResumeCandidate = ct.ResumeCandidate;
export type CommandSourceInfo = ct.CommandSourceInfo;
export type CommandEntry = ct.CommandEntry;
export type ChatImage = ct.ChatImage;

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
 * Seam adapter: chat.name origin union (auto | user | provider) — the
 * workspace title callbacks in features accept the same union.
 */
type ChatNameFrameSeam = Omit<ct.ChatNameFrame, "origin"> & { readonly origin: "auto" | "user" | "provider" };

/**
 * Seam adapter: notice carries epoch milliseconds at the client boundary (the
 * parse boundary converts the wire's RFC3339Nano `at` string, invariant 14)
 * and a record payload — useChatFrameState sorts notices numerically by `at`
 * and stores the payload as JsonObject.
 */
type NoticeFrameSeam = Omit<ct.NoticeFrame, "at" | "payload"> & {
  readonly at?: number;
  readonly payload?: JsonObject;
};

/**
 * Seam adapter: `final` is REQUIRED on every entries page on the wire
 * (invariant 18) and the parser enforces it, but the seam keeps it optional
 * because features deliver final-less entries literals directly to handlers;
 * `entries` stays `unknown` because features construct page payloads from
 * untyped history records (the parser still emits the generated array type).
 */
type EntriesFrameSeam = Omit<ct.EntriesFrame, "entries" | "final"> & {
  readonly entries: unknown;
  readonly final?: boolean;
};

/**
 * Seam adapter: block arguments stay `unknown` at the client boundary —
 * features rebuild toolResult blocks from untyped history content and assign
 * structured-argument records the generated JsonValue cannot type.
 */
type ContentBlockSeam = Omit<ct.ContentBlock, "arguments"> & { readonly arguments?: unknown };

/** Seam adapter: AssistantMessage carries the seam ContentBlock in blocks, so
 * features' UiMessage (extends AssistantMessage) keeps one block type. */
type AssistantMessageSeam = Omit<ct.AssistantMessage, "blocks"> & {
  readonly blocks?: readonly ContentBlockSeam[];
};

/** Seam adapter: completed message frames carry the seam AssistantMessage. */
type MessageFrameSeam = Omit<ct.MessageFrame, "message"> & { readonly message: AssistantMessageSeam };

/**
 * Seam adapter: error.code stays an open string at the client boundary. The
 * Feature code treats errors as an open string even though every currently
 * established backend code is represented by the closed wire enum.
 * FailedRpcCommand stays open for provider command compatibility.
 */
interface ErrorFrameSeam {
  readonly type: "error";
  readonly sessionId?: string;
  readonly code?: string;
  readonly command?: FailedRpcCommand;
  readonly requestId?: string;
  /** resume_failed only: stored identity path no longer exists */
  readonly dangling?: boolean;
  /** resume_failed only: scanned sibling branch candidates */
  readonly candidates?: readonly ResumeCandidate[];
  readonly message: string;
}

export type ChatServerFrame =
  | ct.ReadyFrame
  | ChatNameFrameSeam
  | ct.MessageDeltaFrame
  | MessageFrameSeam
  | ct.ToolFrame
  | ct.StateFrame
  | ct.StatsFrame
  | ct.ExtensionEventFrame
  | ct.ApprovalFrame
  | ct.CommandsFrame
  | ct.ModelsFrame
  | EntriesFrameSeam
  | ct.CompactionStartedFrame
  | ct.CompactionDoneFrame
  | ct.RunStartedFrame
  | ct.RunDoneFrame
  | ct.AckFrame
  | ct.ControlResultFrame
  | ErrorFrameSeam
  | NoticeFrameSeam;

export type ChatClientFrame =
  | ct.PingFrame
  | ct.ChatCreateFrame
  | ct.ChatSendFrame
  | ct.ChatAbortFrame
  | ct.ChatCloseFrame
  | ct.ChatDisconnectFrame
  | ct.ChatSetFrame
  | ct.ApprovalRespondFrame
  | ct.ChatCommandsFrame
  | ct.ChatCompactFrame
  | ct.ChatModelsFrame
  | ct.ChatStatsFrame
  | ct.ActivityRefreshFrame
  | ct.ChatResumeFrame
  | ct.ClientHelloFrame;

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

/**
 * Wire contract version this client speaks. The server's hello must match;
 * a mismatch warns and proceeds (contract: version skew is never fatal).
 */
export const CHAT_WIRE_VERSION = 2;
export const CHAT_WS_ENDPOINT = "/api/v2/ws";

/** Validate the connector's handshake frame against the generated HelloFrame. */
function parseHello(msg: unknown): ct.HelloFrame | null {
  const parsed = parseServerFrame(msg);
  // The generated union includes UnknownFrame, so its open `type` prevents
  // control-flow narrowing even though the generated parser chose HelloFrame.
  return parsed?.type === "hello" ? parsed as ct.HelloFrame : null;
}

export const connectChat: ChatConnector = (handlers) => {
  // --- v2 hello handshake state -------------------------------------------
  // helloSeen settles on the FIRST server frame whatever it is: a real hello
  // is swallowed (after a version check); any other first frame means the
  // server never sends hello (v1 continuity) — warn once and treat the
  // stream as live. Late hello frames are dropped, never delivered.
  let helloSeen = false;
  let helloWarned = false;
  // --- reconnect re-bind state ---------------------------------------------
  // The chat binding is rebuilt on reconnect (snapshot-then-live ordering on
  // the server makes the replay self-settling). The connector remembers the
  // last chat.create and replays it after the handshake if the consumer has
  // not already sent one on this connection.
  let openedOnce = false;
  let rebindPending = false;
  let createSentSinceOpen = false;
  let lastCreate: ct.ChatCreateFrame | null = null;
  // Assigned right after connectWs() returns; ws.ts only dispatches onOpen/
  // onMessage from socket callbacks, so it is set before either can fire.
  let sendClient: ((msg: ChatClientFrame) => boolean) | null = null;

  const replayCreateIfNeeded = (): void => {
    if (!rebindPending || createSentSinceOpen || lastCreate === null) return;
    rebindPending = false;
    sendClient?.(lastCreate);
  };

  const wsHandlers: WsHandlers = {
    onOpen: () => {
      helloSeen = false;
      createSentSinceOpen = false;
      rebindPending = openedOnce;
      openedOnce = true;
      // Contract: the client announces its wire version first.
      sendClient?.({ type: "hello", version: CHAT_WIRE_VERSION });
      handlers.onOpen?.();
    },
    onMessage: (msg) => {
      if (!helloSeen) {
        helloSeen = true;
        const hello = parseHello(msg);
        if (hello) {
          if (hello.version !== CHAT_WIRE_VERSION) {
            console.warn(
              `[chatWs] wire contract version mismatch: client v${CHAT_WIRE_VERSION}, server v${hello.version} (${hello.serverVersion}) — proceeding`,
            );
          }
          // Reconnect re-bind: the consumer may already have sent chat.create
          // from its onOpen (which fires before the hello arrives); otherwise
          // the connector replays the remembered binding here.
          replayCreateIfNeeded();
          return;
        }
        if (!helloWarned) {
          helloWarned = true;
          console.warn("[chatWs] server opened the stream without a hello frame — proceeding");
        }
        replayCreateIfNeeded();
        // Fall through: the first frame is a session frame and must be
        // delivered below.
      } else if (frameTypeOf(msg) === "hello") {
        return; // late or replayed hello: not a session frame
      }
      const frame = parseChatServerFrame(msg);
      if (frame) handlers.onFrame(frame); // null drops unknown/malformed silently (R1)
    },
    ...(handlers.onParseError ? { onParseError: handlers.onParseError } : {}),
    ...(handlers.onClose ? { onClose: handlers.onClose } : {}),
  };

  const conn = connectWs(CHAT_WS_ENDPOINT, wsHandlers, {
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
  const client: ChatClient = {
    send: (m) => {
      if (m.type === "chat.create") {
        lastCreate = m;
        createSentSinceOpen = true;
        rebindPending = false;
      }
      return conn.send(m);
    },
    close: () => conn.close(),
  };
  sendClient = client.send;
  return client;
};
