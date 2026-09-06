import type { ChatClientFrame, ChatServerFrame } from "../../lib/chatWs";
import type { ApprovalRequest } from "./ApprovalModal";
import type { UiMessage } from "./chatEntries";
import { messageText, parseEntries } from "./chatEntries";
import type { ChatDraft, ToolEntry } from "./chatSessionTypes";
import { materializeFinalTools } from "./chatFinalTools";
import type { SteerMark } from "./chatSteerMarks";

export function extractToolText(value?: { readonly content?: readonly { readonly text?: string }[] }): string {
  return value?.content?.map((item) => item.text ?? "").join("") ?? "";
}

type ToolFrame = Extract<ChatServerFrame, { readonly type: "tool" }>;
type ApprovalFrame = Extract<ChatServerFrame, { readonly type: "approval" }>;

/** Fold a live tool frame into the per-call tool entry map. */
export function nextToolEntry(
  current: Readonly<Record<string, ToolEntry>>,
  frame: ToolFrame,
): Readonly<Record<string, ToolEntry>> {
  const previous = current[frame.toolCallId];
  const text =
    frame.phase === "end" ? extractToolText(frame.result) || extractToolText(frame.partial) : extractToolText(frame.partial);
  const details = frame.phase === "end" ? frame.result?.details : frame.partial?.details;
  return {
    ...current,
    [frame.toolCallId]: {
      toolName: frame.toolName,
      phase: frame.phase,
      text: text || previous?.text || "",
      isError: frame.isError ?? previous?.isError ?? false,
      details: details !== undefined ? details : previous?.details,
      args: frame.args !== undefined ? frame.args : previous?.args,
    },
  };
}

/** Map a server approval frame onto the modal request, keeping defined fields only. */
export function approvalRequestOf(frame: ApprovalFrame): ApprovalRequest {
  return {
    id: frame.id,
    method: frame.method,
    ...(frame.title ? { title: frame.title } : {}),
    ...(frame.message ? { message: frame.message } : {}),
    ...(frame.options ? { options: frame.options } : {}),
    ...(frame.prefill ? { prefill: frame.prefill } : {}),
    ...(frame.placeholder ? { placeholder: frame.placeholder } : {}),
  };
}

export function finalizeRunMessages(
  messages: readonly UiMessage[],
  toolCalls: Readonly<Record<string, ToolEntry>>,
): readonly UiMessage[] | null {
  // Steer-marked rows survive the run terminal. The mark is UI bookkeeping
  // the client owns: observed engine behavior persists the steer as a plain
  // user-role entry with no marker and never re-supplies a marked row, so
  // dropping the local echo here only erased the text. History
  // reconciliation re-tags the canonical plain flush instead (steerMarks).
  const hasTools = Object.keys(toolCalls).length > 0;
  if (!hasTools) return null;
  return materializeFinalTools(messages, toolCalls);
}

export function queuedSendFrame(
  draft: { readonly text: string; readonly image: ChatDraft["image"] },
  requestId: string,
  sessionId: string,
): ChatClientFrame {
  return {
    type: "chat.send",
    sessionId,
    requestId,
    run: {
      kind: "prompt",
      message: draft.text,
      ...(draft.image ? { images: [{ data: draft.image.data, mimeType: draft.image.mimeType }] } : {}),
    },
  };
}

/** Canonical snapshot plus canonical receipt suffix; only equal entry IDs coalesce. */
export function reconcileHistory({ entries, current, preserveCurrent, steerMarks }: {
  readonly entries: unknown;
  readonly current: readonly UiMessage[];
  readonly preserveCurrent: boolean;
  readonly steerMarks?: readonly SteerMark[];
}): { readonly messages: readonly UiMessage[] } {
  const restored = parseEntries(entries);
  const ids = new Set(restored.flatMap(message => message.id === undefined ? [] : [message.id]));
  const messages = preserveCurrent
    ? [...restored, ...current.filter(message => message.id === undefined || !ids.has(message.id))]
    : restored;
  return { messages: applySteerMarks(messages, steerMarks ?? []) };
}

/** Occurrence sidecar is presentation only, never request ownership. */
export function applySteerMarks(messages: readonly UiMessage[], marks: readonly SteerMark[]): readonly UiMessage[] {
  const byOrdinal = new Map(marks.map(mark => [mark.ordinal, mark]));
  let ordinal = 0;
  return messages.map(message => {
    if (message.role !== "user") return message;
    const mark = byOrdinal.get(++ordinal);
    return mark && mark.text === messageText(message) && message.customType !== "steer" ? { ...message, customType: "steer" } : message;
  });
}
