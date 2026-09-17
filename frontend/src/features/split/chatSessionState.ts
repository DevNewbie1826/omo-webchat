import type { ChatClientFrame, ChatServerFrame, ContentBlock, ToolPayload } from "../../lib/chatWs";
import type { ApprovalRequest } from "./QuestionWindow";
import type { UiMessage } from "./chatEntries";
import { messageText, parseEntries } from "./chatEntries";
import type { ChatDraft, ToolEntry, ToolResultImage } from "./chatSessionTypes";
import { materializeFinalTools } from "./chatFinalTools";
import type { SteerMark } from "./chatSteerMarks";

export function extractToolText(value?: { readonly content?: readonly { readonly text?: string }[] }): string {
  return value?.content?.map((item) => item.text ?? "").join("") ?? "";
}

type ToolFrame = Extract<ChatServerFrame, { readonly type: "tool" }>;
// The strict dock mapper takes only fully-parsed approval frames; the
// FallbackApprovalFrame safety net never flows through it.
type ApprovalFrame = Exclude<Extract<ChatServerFrame, { readonly type: "approval" }>, { readonly fallback: true }>;

/** Images carried by a tool payload's content, in content order. The server
 * forwards the provider's native block discriminator (`type`) and may add a
 * synthetic `kind`; either form identifies an image item. */
function toolPayloadMedia(payload?: ToolPayload): readonly ToolResultImage[] {
  const media: ToolResultImage[] = [];
  for (const item of payload?.content ?? []) {
    const kind = item.type ?? item.kind;
    if (kind === "image" && typeof item.data === "string") {
      media.push({
        data: item.data,
        ...(item.mimeType !== undefined ? { mimeType: item.mimeType } : {}),
        ...(item.byteLength !== undefined ? { byteLength: item.byteLength } : {}),
      });
    } else if (kind === "image_ref" && item.ref !== undefined) {
      media.push({
        ...(item.mimeType !== undefined ? { mimeType: item.mimeType } : {}),
        ...(item.byteLength !== undefined ? { byteLength: item.byteLength } : {}),
        ref: item.ref,
      });
    }
  }
  return media;
}

/** Image blocks carried by a live toolResult message, in block order. */
function toolResultMessageMedia(message: { readonly blocks?: readonly ContentBlock[] }): readonly ToolResultImage[] {
  const media: ToolResultImage[] = [];
  for (const block of message.blocks ?? []) {
    if (block.kind === "image" && typeof block.data === "string") {
      media.push({
        data: block.data,
        ...(block.mimeType !== undefined ? { mimeType: block.mimeType } : {}),
        ...(block.byteLength !== undefined ? { byteLength: block.byteLength } : {}),
      });
    } else if (block.kind === "image_ref" && block.ref !== undefined) {
      media.push({
        ...(block.mimeType !== undefined ? { mimeType: block.mimeType } : {}),
        ...(block.byteLength !== undefined ? { byteLength: block.byteLength } : {}),
        ref: block.ref,
      });
    }
  }
  return media;
}

function sameImage(a: ToolResultImage, b: ToolResultImage): boolean {
  if (a.ref !== undefined || b.ref !== undefined) {
    return a.ref?.toolCallId === b.ref?.toolCallId && a.ref?.contentIndex === b.ref?.contentIndex;
  }
  return a.data === b.data;
}

function entryHasImage(entry: ToolEntry, image: ToolResultImage): boolean {
  return (entry.media ?? []).some((existing) => sameImage(existing, image));
}

/** Fold a live tool frame into the per-call tool entry map. */
export function nextToolEntry(
  current: Readonly<Record<string, ToolEntry>>,
  frame: ToolFrame,
): Readonly<Record<string, ToolEntry>> {
  const previous = current[frame.toolCallId];
  const text =
    frame.phase === "end" ? extractToolText(frame.result) || extractToolText(frame.partial) : extractToolText(frame.partial);
  const details = frame.phase === "end" ? frame.result?.details : frame.partial?.details;
  const media = toolPayloadMedia(frame.phase === "end" ? frame.result : frame.partial);
  return {
    ...current,
    [frame.toolCallId]: {
      toolName: frame.toolName,
      phase: frame.phase,
      text: text || previous?.text || "",
      isError: frame.isError ?? previous?.isError ?? false,
      details: details !== undefined ? details : previous?.details,
      args: frame.args !== undefined ? frame.args : previous?.args,
      ...(media.length > 0 ? { media } : previous?.media !== undefined ? { media: previous.media } : {}),
    },
  };
}

/**
 * Merge a live role "toolResult" message's images into the invocation they
 * belong to. The parse seam preserves the message-level toolCallId (the
 * engine repeats each invocation's result as a role "toolResult" message
 * right after the matching end frame): when present, the merge is strictly
 * by that identity — the named invocation, or nowhere when it is unknown,
 * never an older completed call. Only identity-less messages (legacy
 * engines) fall back to an image_ref placeholder's own toolCallId and then
 * positionally: the latest completed call not already holding the image.
 * Returns null when there is nothing to merge (no images, or no invocation
 * to attach them to) so the caller can skip the state write.
 */
export function mergeToolResultMedia(
  current: Readonly<Record<string, ToolEntry>>,
  message: { readonly blocks?: readonly ContentBlock[]; readonly toolCallId?: string },
): Readonly<Record<string, ToolEntry>> | null {
  const ids = Object.keys(current);
  if (ids.length === 0) return null;
  let next = current;
  let changed = false;
  for (const image of toolResultMessageMedia(message)) {
    const refId = image.ref?.toolCallId;
    let targetId: string | undefined;
    if (message.toolCallId !== undefined) {
      // Identity-strict: the message names its invocation, so the image
      // merges there or nowhere — positional guessing would attach a
      // repeated inline result to an unrelated older completed call.
      targetId = current[message.toolCallId] !== undefined ? message.toolCallId : undefined;
    } else {
      targetId = refId !== undefined && current[refId] !== undefined ? refId : undefined;
      if (targetId === undefined) {
        for (let index = ids.length - 1; index >= 0; index -= 1) {
          const id = ids[index];
          const entry = id === undefined ? undefined : next[id];
          if (entry?.phase !== "end" || entryHasImage(entry, image)) continue;
          targetId = id;
          break;
        }
      }
    }
    const id = targetId;
    const entry = id === undefined ? undefined : next[id];
    if (id === undefined || entry === undefined || entryHasImage(entry, image)) continue;
    next = { ...next, [id]: { ...entry, media: [...(entry.media ?? []), image] } };
    changed = true;
  }
  return changed ? next : null;
}

/** Map a server approval frame onto the window request, keeping defined fields only. */
export function approvalRequestOf(frame: ApprovalFrame & { readonly method: ApprovalRequest["method"] }): ApprovalRequest {
  return {
    id: frame.id,
    method: frame.method,
    ...(frame.title ? { title: frame.title } : {}),
    ...(frame.message ? { message: frame.message } : {}),
    ...(frame.options ? { options: frame.options } : {}),
    ...(frame.prefill ? { prefill: frame.prefill } : {}),
    ...(frame.placeholder ? { placeholder: frame.placeholder } : {}),
    ...(frame.deadlineAtMs !== undefined ? { deadlineAtMs: frame.deadlineAtMs } : {}),
    ...(frame.remainingMs !== undefined ? { remainingMs: frame.remainingMs } : {}),
    ...(frame.questions ? { questions: frame.questions } : {}),
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
