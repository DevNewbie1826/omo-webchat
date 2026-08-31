import type { AssistantMessage, ContentBlock } from "../../lib/chatWs";

export interface UiMessage extends AssistantMessage {
  readonly optimisticId?: number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isStructuredArguments(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

function parseTimestamp(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function parseBlocks(content: unknown): readonly ContentBlock[] {
  if (typeof content === "string") return [{ kind: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const value of content) {
    if (!isRecord(value)) continue;
    const type = value["type"];
    const valueText = value["text"];
    if (typeof type !== "string" && typeof valueText !== "string") continue;
    const kind = typeof type === "string" ? type : "text";
    const thinking = value["thinking"];
    const id = value["id"];
    const name = value["name"];
    const isError = value["isError"];
    const args = value["arguments"];
    const block: ContentBlock = {
      kind,
      ...(typeof valueText === "string" ? { text: valueText } : {}),
      ...(typeof thinking === "string" ? { thinking } : {}),
      ...(typeof id === "string" ? { id } : {}),
      ...(typeof name === "string" ? { name } : {}),
      ...(isStructuredArguments(args) ? { arguments: args } : {}),
      ...(typeof isError === "boolean" ? { isError } : {}),
    };
    // A restored toolResult carries the output for an invocation. Fold it into
    // that toolCall/tool block so one logical call normalizes to a single named
    // disclosure containing the result (matching the finalized live form)
    // instead of a detached, unnamed second card. Match by id/toolCallId when
    // the result carries one so a mismatched result is never attached to the
    // wrong call; otherwise fall back to strict adjacency.
    if (kind === "toolResult") {
      const prev = blocks[blocks.length - 1];
      if (prev && (prev.kind === "toolCall" || prev.kind === "tool")) {
        const resultId =
          typeof id === "string" ? id : typeof value["toolCallId"] === "string" ? value["toolCallId"] : undefined;
        if (resultId === undefined || prev.id === resultId) {
          blocks[blocks.length - 1] = {
            ...prev,
            kind: "tool",
            ...(block.text !== undefined ? { text: block.text } : {}),
            ...(block.isError !== undefined ? { isError: block.isError } : {}),
          };
          continue;
        }
      }
    }
    blocks.push(block);
  }
  return blocks;
}

function toolResultText(content: unknown): string {
  return parseBlocks(content)
    .filter((block) => block.kind === "text")
    .map((block) => block.text ?? "")
    .join("");
}

/**
 * Fold a separate top-level toolResult message (the provider's stored shape:
 * role "toolResult" with message-level toolCallId/toolName/content/isError)
 * into the preceding invocation carrying the matching toolCall block, so one
 * logical call renders a single named disclosure containing the result. When no
 * matching invocation exists, keep one contained tool block instead of letting
 * the output detach into a plain-text row.
 */
function mergeToolResultMessage(messages: UiMessage[], message: Readonly<Record<string, unknown>>): void {
  const toolCallId = message["toolCallId"];
  const toolName = message["toolName"];
  const isError = message["isError"];
  const text = toolResultText(message["content"]);
  const result: ContentBlock = {
    kind: "tool",
    ...(typeof toolCallId === "string" ? { id: toolCallId } : {}),
    ...(typeof toolName === "string" ? { name: toolName } : {}),
    text,
    ...(typeof isError === "boolean" ? { isError } : {}),
  };
  if (typeof toolCallId === "string") {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const target = messages[index];
      const blocks = target?.blocks ?? [];
      const blockIndex = blocks.findIndex(
        (block) => (block.kind === "toolCall" || block.kind === "tool") && block.id === toolCallId,
      );
      if (!target || blockIndex < 0) continue;
      const existing = blocks[blockIndex];
      if (!existing) continue;
      const merged: ContentBlock = {
        ...existing,
        kind: "tool",
        text,
        ...(existing.name === undefined && result.name !== undefined ? { name: result.name } : {}),
        ...(result.isError !== undefined ? { isError: result.isError } : {}),
      };
      messages[index] = { ...target, blocks: blocks.map((block, i) => (i === blockIndex ? merged : block)) };
      return;
    }
  }
  messages.push({ role: "assistant", blocks: [result], ts: 0 });
}

export function messageText(message: AssistantMessage): string {
  return (message.blocks ?? [])
    .filter((block) => block.kind === "text")
    .map((block) => block.text ?? "")
    .join("");
}

export function concatEntries(pages: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const page of pages) {
    if (Array.isArray(page)) {
      for (const entry of page) out.push(entry);
    }
  }
  return out;
}

export function parseEntries(entries: unknown): UiMessage[] {
  if (!Array.isArray(entries)) return [];
  const messages: UiMessage[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (entry["type"] === "custom_message") {
      const customType = entry["customType"];
      const content = entry["content"];
      if (typeof customType !== "string" || typeof content !== "string") continue;
      messages.push({
        role: "custom",
        customType,
        blocks: [{ kind: "text", text: content }],
        ts: parseTimestamp(entry["timestamp"]),
      });
      continue;
    }
    if (entry["type"] !== "message") continue;
    const message = entry["message"];
    if (!isRecord(message)) continue;
    const role = message["role"];
    if (typeof role !== "string") continue;
    if (role === "toolResult") {
      mergeToolResultMessage(messages, message);
      continue;
    }
    const timestamp = message["timestamp"];
    const model = message["model"];
    messages.push({
      role,
      blocks: parseBlocks(message["content"]),
      ts: typeof timestamp === "number" ? timestamp : 0,
      ...(typeof model === "string" ? { model } : {}),
    });
  }
  return messages;
}
