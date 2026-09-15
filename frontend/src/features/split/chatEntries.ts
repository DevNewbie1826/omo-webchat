import type { AssistantMessage, ContentBlock } from "../../lib/chatWs";

export interface UiMessage extends AssistantMessage {
  readonly id?: string;
  /** Compacted token count carried by a persisted compaction summary entry. */
  readonly tokensBefore?: number;
  /** Persisted-summary provenance: set ONLY for entries whose persisted type
   * is "compaction" or "branch_summary". Summary-box routing keys on this
   * discriminator alone, so arbitrary custom-message customType names are
   * never reserved and keep rendering as HookCards. */
  readonly summaryKind?: "compaction" | "branch_summary";
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

/** Summary-entry timestamp: a valid entry timestamp (numeric — epoch zero
 * included — or a parseable string) wins; absent or invalid values fall back
 * to the hydration receipt time frozen once per parseEntries call, so every
 * accepted summary box keeps a stable time instead of a changing render-time
 * stamp. */
function parseSummaryTimestamp(value: unknown, receiptTime: number): number {
  // A numeric timestamp is accepted only when it represents a valid Date
  // instant: finite but out-of-Date-range values (beyond +/-8640000000000000)
  // would render NaN times, so they fall back like any invalid timestamp.
  if (typeof value === "number" && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime())) return value;
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp) && !Number.isNaN(new Date(timestamp).getTime())) return timestamp;
  }
  return receiptTime;
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
    const data = value["data"];
    const mimeType = value["mimeType"];
    const byteLength = value["byteLength"];
    const rawRef = value["ref"];
    const ref =
      isRecord(rawRef) && typeof rawRef["toolCallId"] === "string" && typeof rawRef["contentIndex"] === "number"
        ? { toolCallId: rawRef["toolCallId"], contentIndex: rawRef["contentIndex"] }
        : undefined;
    const block: ContentBlock = {
      kind,
      ...(typeof valueText === "string" ? { text: valueText } : {}),
      ...(typeof thinking === "string" ? { thinking } : {}),
      ...(typeof id === "string" ? { id } : {}),
      ...(typeof name === "string" ? { name } : {}),
      ...(isStructuredArguments(args) ? { arguments: args } : {}),
      ...(typeof isError === "boolean" ? { isError } : {}),
      ...(typeof data === "string" ? { data } : {}),
      ...(typeof mimeType === "string" ? { mimeType } : {}),
      ...(typeof byteLength === "number" ? { byteLength } : {}),
      ...(ref !== undefined ? { ref } : {}),
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
            ...(block.data !== undefined ? { data: block.data } : {}),
            ...(block.mimeType !== undefined ? { mimeType: block.mimeType } : {}),
            ...(block.byteLength !== undefined ? { byteLength: block.byteLength } : {}),
            ...(block.ref !== undefined ? { ref: block.ref } : {}),
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

/** Image blocks carried by a restored toolResult's content, in content order. */
function toolResultImages(content: unknown): readonly ContentBlock[] {
  return parseBlocks(content).filter((block) => block.kind === "image" || block.kind === "image_ref");
}

/**
 * Fold a separate top-level toolResult message (the provider's stored shape:
 * role "toolResult" with message-level toolCallId/toolName/content/isError)
 * into the preceding invocation carrying the matching toolCall block, so one
 * logical call renders a single named disclosure containing the result. When no
 * matching invocation exists, keep one contained tool block instead of letting
 * the output detach into a plain-text row.
 */
function mergeToolResultMessage(messages: UiMessage[], message: Readonly<Record<string, unknown>>, entryId: unknown): void {
  const toolCallId = message["toolCallId"];
  const toolName = message["toolName"];
  const isError = message["isError"];
  const text = toolResultText(message["content"]);
  // The ContentBlock shape carries one image slot, so the first image's fields
  // land on the merged block; additional images survive as standalone blocks.
  const images = toolResultImages(message["content"]);
  const image = images[0];
  const result: ContentBlock = {
    kind: "tool",
    ...(typeof toolCallId === "string" ? { id: toolCallId } : {}),
    ...(typeof toolName === "string" ? { name: toolName } : {}),
    text,
    ...(typeof isError === "boolean" ? { isError } : {}),
    ...(image?.data !== undefined ? { data: image.data } : {}),
    ...(image?.mimeType !== undefined ? { mimeType: image.mimeType } : {}),
    ...(image?.byteLength !== undefined ? { byteLength: image.byteLength } : {}),
    ...(image?.ref !== undefined ? { ref: image.ref } : {}),
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
        ...(result.data !== undefined ? { data: result.data } : {}),
        ...(result.mimeType !== undefined ? { mimeType: result.mimeType } : {}),
        ...(result.byteLength !== undefined ? { byteLength: result.byteLength } : {}),
        ...(result.ref !== undefined ? { ref: result.ref } : {}),
      };
      messages[index] = {
        ...target,
        blocks: [...blocks.slice(0, blockIndex), merged, ...images.slice(1), ...blocks.slice(blockIndex + 1)],
      };
      return;
    }
  }
  messages.push({
    ...(typeof entryId === "string" ? { id: entryId } : {}),
    role: "assistant",
    blocks: [result, ...images.slice(1)],
    ts: 0,
  });
}

/**
 * True when the assistant turn ended unsuccessfully: it carries failure text
 * (errorMessage present, even empty — the renderer falls back to a generic
 * label) or its stopReason reports a genuine error. A bare "aborted" with no
 * failure text is a user stop (observed engine contract: the user-stop path
 * stamps stopReason "aborted" alongside ordinary text), never a failure, so
 * a cancelled turn renders no error row. The failure must render attached to
 * its turn, matching the observed reference behavior of never hiding it.
 */
export function isFailedTurn(message: AssistantMessage): boolean {
  if (message.role !== "assistant") return false;
  if (message.errorMessage !== undefined) return true;
  return message.stopReason === "error";
}

/** Zero-renderable-block assistant messages are omitted from rendering.
 * Presentation-seam predicate only: transcript state keeps them — live and
 * restored alike — because they anchor current-turn tool results when
 * run.done materializes them; ChatTranscript hides their blank rows only
 * after row identity is assigned. Any message with blocks — including one
 * made non-empty by tool-result folding — counts as renderable, as does a
 * failed turn: its failure row must never be hidden with the blank row. */
export function hasRenderableContent(message: AssistantMessage): boolean {
  if (message.role === "assistant" && isFailedTurn(message)) return true;
  return !(message.role === "assistant" && (message.blocks ?? []).length === 0);
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
  // Hydration receipt time, frozen once per hydration pass: summary entries
  // with an absent/invalid timestamp fall back to this stable value.
  const hydrationReceiptTime = Date.now();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (entry["type"] === "custom_message") {
      const customType = entry["customType"];
      const content = entry["content"];
      if (typeof customType !== "string" || typeof content !== "string") continue;
      // Observed engine contract: only custom messages explicitly flagged for
      // display enter the transcript; anything else is dropped.
      const inner = entry["message"];
      const display = entry["display"] ?? (isRecord(inner) ? inner["display"] : undefined);
      if (display !== true) continue;
      const id = entry["id"];
      messages.push({
        ...(typeof id === "string" ? { id } : {}),
        role: "custom",
        customType,
        blocks: [{ kind: "text", text: content }],
        ts: parseTimestamp(entry["timestamp"]),
      });
      continue;
    }
    // Persisted summary entries (observed engine behavior/contract):
    // compaction summaries persist as entries of type "compaction", branch
    // summaries as "branch_summary". Both resurface during history hydration
    // and render as summary boxes. Observed persisted compaction envelopes
    // carry top-level `summary` (string) and `tokensBefore` (number) beside
    // id/timestamp; observed persisted branch_summary envelopes carry the
    // same top-level `summary` (string) plus `fromId` (string), with an
    // ISO-string timestamp and no token count, so no token line is rendered
    // for branch boxes. Entries without a string summary are dropped rather
    // than invented. The summaryKind tag carries the persisted-type
    // provenance so rendering routes on it alone, never on the customType
    // name.
    if (entry["type"] === "compaction" || entry["type"] === "branch_summary") {
      const summary = entry["summary"];
      if (typeof summary !== "string") continue;
      const id = entry["id"];
      const tokensBefore = entry["tokensBefore"];
      const summaryKind = entry["type"];
      messages.push({
        ...(typeof id === "string" ? { id } : {}),
        role: "custom",
        customType: summaryKind,
        summaryKind,
        blocks: [{ kind: "text", text: summary }],
        ts: parseSummaryTimestamp(entry["timestamp"], hydrationReceiptTime),
        ...(summaryKind === "compaction" && typeof tokensBefore === "number" ? { tokensBefore } : {}),
      });
      continue;
    }
    if (entry["type"] !== "message") continue;
    const message = entry["message"];
    if (!isRecord(message)) continue;
    const role = message["role"];
    if (typeof role !== "string") continue;
    if (role === "toolResult") {
      mergeToolResultMessage(messages, message, entry["id"]);
      continue;
    }
    const timestamp = message["timestamp"];
    const model = message["model"];
    const id = entry["id"];
    // Failure fields observed on the wire for turns that ended
    // unsuccessfully; persisted entries carry them beside content, and they
    // must survive hydration so the failure renders attached to its turn.
    const errorMessage = message["errorMessage"];
    const stopReason = message["stopReason"];
    const parsed: UiMessage = {
      ...(typeof id === "string" ? { id } : {}),
      role,
      blocks: parseBlocks(message["content"]),
      ts: typeof timestamp === "number" ? timestamp : 0,
      ...(typeof model === "string" ? { model } : {}),
      ...(typeof errorMessage === "string" ? { errorMessage } : {}),
      ...(typeof stopReason === "string" ? { stopReason } : {}),
    };
    // Kept in state even with zero blocks: an empty restored completion
    // anchors current-turn tool results exactly like the live path, so
    // parseEntries must not drop it. Blank-row hiding is owned by the
    // presentation seam (ChatTranscript), never by transcript state.
    messages.push(parsed);
  }
  return messages;
}
