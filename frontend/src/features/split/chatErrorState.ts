import type { ChatServerFrame } from "../../lib/chatWs";

type ErrorFrame = Extract<ChatServerFrame, { readonly type: "error" }>;

const TERMINAL_ERROR_CODES = new Set([
  "bad_create",
  "no_workspace",
  "no_chat",
  "store_failed",
  "bad_provider",
  "duplicate_create",
  "start_failed",
  "initialize_failed",
  "resume_failed",
  "no_session",
  "bad_send",
  "send_failed",
  "decode_failed",
  "provider_overflow",
  "provider_timeout",
  "pi_eof",
]);

export function isPromptTerminalError(frame: ErrorFrame): boolean {
  return frame.command === "prompt" || TERMINAL_ERROR_CODES.has(frame.code ?? "");
}
