import type { ContentBlock } from "../../lib/chatWs";
import type { UiMessage } from "./chatEntries";
import type { ToolEntry } from "./chatSessionTypes";

export function materializeFinalTools(
  messages: readonly UiMessage[],
  tools: Readonly<Record<string, ToolEntry>>,
): readonly UiMessage[] {
  const toolCallIds = Object.keys(tools);
  if (toolCallIds.length === 0) return messages;
  const toolBlocks: ContentBlock[] = toolCallIds.map((toolCallId) => {
    const entry = tools[toolCallId];
    return {
      kind: "tool",
      id: toolCallId,
      name: entry?.toolName ?? "",
      ...(entry?.args !== undefined ? { arguments: entry.args } : {}),
      text: entry?.text ?? "",
      isError: entry?.isError ?? false,
    };
  });
  const finalById = new Map(toolBlocks.map((block) => [block.id ?? "", block]));
  const replacedIds = new Set<string>();
  let lastAssistantIndex = -1;
  const replaced = messages.map((message, index) => {
    if (message.role !== "assistant") return message;
    lastAssistantIndex = index;
    const existing = message.blocks ?? [];
    let changed = false;
    const merged = existing.map((block) => {
      if (block.id === undefined) return block;
      if (block.kind !== "tool" && block.kind !== "toolCall" && block.kind !== "toolResult") return block;
      const replacement = finalById.get(block.id);
      if (!replacement) return block;
      replacedIds.add(block.id);
      changed = true;
      return { ...block, ...replacement };
    });
    return changed ? { ...message, blocks: merged } : message;
  });
  const unresolved = toolBlocks.filter((block) => !replacedIds.has(block.id ?? ""));
  if (unresolved.length === 0) return replaced;
  if (lastAssistantIndex >= 0) {
    return replaced.map((message, index) =>
      index === lastAssistantIndex ? { ...message, blocks: [...unresolved, ...(message.blocks ?? [])] } : message,
    );
  }
  return [...replaced, { role: "assistant", blocks: unresolved }];
}
