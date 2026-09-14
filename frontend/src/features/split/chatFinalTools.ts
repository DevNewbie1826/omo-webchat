import type { ContentBlock } from "../../lib/chatWs";
import type { UiMessage } from "./chatEntries";
import type { ToolEntry, ToolResultImage } from "./chatSessionTypes";

/** Standalone content blocks for an entry's non-primary result images; they
 * render inside the invocation's disclosure, gated on expansion. */
function mediaBlocks(media: readonly ToolResultImage[]): readonly ContentBlock[] {
  return media.map((image) =>
    image.data !== undefined
      ? {
        kind: "image",
        data: image.data,
        ...(image.mimeType !== undefined ? { mimeType: image.mimeType } : {}),
        ...(image.byteLength !== undefined ? { byteLength: image.byteLength } : {}),
      }
      : {
        kind: "image_ref",
        ...(image.mimeType !== undefined ? { mimeType: image.mimeType } : {}),
        ...(image.byteLength !== undefined ? { byteLength: image.byteLength } : {}),
        ...(image.ref !== undefined ? { ref: image.ref } : {}),
      },
  );
}

export function materializeFinalTools(
  messages: readonly UiMessage[],
  tools: Readonly<Record<string, ToolEntry>>,
): readonly UiMessage[] {
  const toolCallIds = Object.keys(tools);
  if (toolCallIds.length === 0) return messages;
  const toolBlocks: ContentBlock[] = [];
  const extrasById = new Map<string, readonly ContentBlock[]>();
  for (const toolCallId of toolCallIds) {
    const entry = tools[toolCallId];
    const media = entry?.media ?? [];
    const image = media[0];
    toolBlocks.push({
      kind: "tool",
      id: toolCallId,
      name: entry?.toolName ?? "",
      ...(entry?.args !== undefined ? { arguments: entry.args } : {}),
      text: entry?.text ?? "",
      isError: entry?.isError ?? false,
      ...(image?.data !== undefined ? { data: image.data } : {}),
      ...(image?.mimeType !== undefined ? { mimeType: image.mimeType } : {}),
      ...(image?.byteLength !== undefined ? { byteLength: image.byteLength } : {}),
      ...(image?.ref !== undefined ? { ref: image.ref } : {}),
    });
    if (media.length > 1) extrasById.set(toolCallId, mediaBlocks(media.slice(1)));
  }
  const finalById = new Map(toolBlocks.map((block) => [block.id ?? "", block]));
  const replacedIds = new Set<string>();
  let lastAssistantIndex = -1;
  const replaced = messages.map((message, index) => {
    if (message.role !== "assistant") return message;
    lastAssistantIndex = index;
    const existing = message.blocks ?? [];
    let changed = false;
    const merged = existing.flatMap((block) => {
      if (block.id === undefined) return [block];
      if (block.kind !== "tool" && block.kind !== "toolCall" && block.kind !== "toolResult") return [block];
      const replacement = finalById.get(block.id);
      if (!replacement) return [block];
      replacedIds.add(block.id);
      changed = true;
      return [{ ...block, ...replacement }, ...(extrasById.get(block.id) ?? [])];
    });
    return changed ? { ...message, blocks: merged } : message;
  });
  const unresolved = toolBlocks
    .filter((block) => !replacedIds.has(block.id ?? ""))
    .flatMap((block) => [block, ...(extrasById.get(block.id ?? "") ?? [])]);
  if (unresolved.length === 0) return replaced;
  if (lastAssistantIndex >= 0) {
    return replaced.map((message, index) =>
      index === lastAssistantIndex ? { ...message, blocks: [...unresolved, ...(message.blocks ?? [])] } : message,
    );
  }
  return [...replaced, { role: "assistant", blocks: unresolved }];
}
