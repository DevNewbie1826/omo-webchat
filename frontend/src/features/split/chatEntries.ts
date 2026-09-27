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

type RawEntry = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is RawEntry {
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
 * stamp. A later parse of the same entry object keeps the receipt time
 * captured when that object was first interpreted. */
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

function toolResultText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block) => block.kind === "text")
    .map((block) => block.text ?? "")
    .join("");
}

/** Image blocks carried by a restored toolResult's content, in content order. */
function toolResultImages(blocks: readonly ContentBlock[]): readonly ContentBlock[] {
  return blocks.filter((block) => block.kind === "image" || block.kind === "image_ref");
}

/**
 * Fold a separate top-level toolResult message (the provider's stored shape:
 * role "toolResult" with message-level toolCallId/toolName/content/isError)
 * into the preceding invocation carrying the matching toolCall block, so one
 * logical call renders a single named disclosure containing the result. When no
 * matching invocation exists, keep one contained tool block instead of letting
 * the output detach into a plain-text row.
 *
 * The fold is not per-entry: the invocation's final object depends on which
 * result entries merge into it. Those results are remembered, per invocation
 * entry, so an unchanged merge returns the same UiMessage.
 */
interface MergeNode {
  /** Message the fold was applied to. A hit is valid only for this preimage. */
  readonly from: UiMessage;
  readonly message: UiMessage;
  readonly next: WeakMap<RawEntry, MergeNode>;
}

interface EmitEffect {
  readonly kind: "emit";
  readonly message: UiMessage;
  /** Merges applied to `message`, keyed by the tool-result entry object. */
  readonly next: WeakMap<RawEntry, MergeNode>;
}

interface ToolEffect {
  readonly kind: "tool";
  readonly toolCallId?: string;
  readonly result: ContentBlock;
  readonly extraImages: readonly ContentBlock[];
  readonly standalone: UiMessage;
  /** Merges applied when this result itself becomes a standalone row. */
  readonly next: WeakMap<RawEntry, MergeNode>;
}

type EntryEffect = { readonly kind: "skip" } | EmitEffect | ToolEffect;

const skipEffect: EntryEffect = { kind: "skip" };

/** Bounded by live entry objects: discarded entries drop their parsed messages. */
const entryEffects = new WeakMap<RawEntry, EntryEffect>();

interface MemoSlot {
  message: UiMessage;
  next: WeakMap<RawEntry, MergeNode>;
}

function emitEffect(message: UiMessage): EmitEffect {
  return { kind: "emit", message, next: new WeakMap() };
}

function toolEffect(message: RawEntry, entryId: unknown): ToolEffect {
  const toolCallId = message["toolCallId"];
  const toolName = message["toolName"];
  const isError = message["isError"];
  const blocks = parseBlocks(message["content"]);
  const text = toolResultText(blocks);
  // The ContentBlock shape carries one image slot, so the first image's fields
  // land on the merged block; additional images survive as standalone blocks.
  const images = toolResultImages(blocks);
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
  const extraImages = images.slice(1);
  return {
    kind: "tool",
    ...(typeof toolCallId === "string" ? { toolCallId } : {}),
    result,
    extraImages,
    standalone: {
      ...(typeof entryId === "string" ? { id: entryId } : {}),
      role: "assistant",
      blocks: [result, ...extraImages],
      ts: 0,
    },
    next: new WeakMap(),
  };
}

function mergedToolMessage(
  target: UiMessage,
  blocks: readonly ContentBlock[],
  blockIndex: number,
  existing: ContentBlock,
  effect: ToolEffect,
): UiMessage {
  const result = effect.result;
  const merged: ContentBlock = {
    ...existing,
    kind: "tool",
    text: result.text ?? "",
    ...(existing.name === undefined && result.name !== undefined ? { name: result.name } : {}),
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
    ...(result.data !== undefined ? { data: result.data } : {}),
    ...(result.mimeType !== undefined ? { mimeType: result.mimeType } : {}),
    ...(result.byteLength !== undefined ? { byteLength: result.byteLength } : {}),
    ...(result.ref !== undefined ? { ref: result.ref } : {}),
  };
  return {
    ...target,
    blocks: [...blocks.slice(0, blockIndex), merged, ...effect.extraImages, ...blocks.slice(blockIndex + 1)],
  };
}

/** Nearest preceding toolCall/tool block with this id, matching the historical fold. */
function applyToolEffect(slots: MemoSlot[], entry: RawEntry, effect: ToolEffect): void {
  const toolCallId = effect.toolCallId;
  if (toolCallId !== undefined) {
    for (let index = slots.length - 1; index >= 0; index -= 1) {
      const slot = slots[index];
      if (!slot) continue;
      const blocks = slot.message.blocks ?? [];
      const blockIndex = blocks.findIndex(
        (block) => (block.kind === "toolCall" || block.kind === "tool") && block.id === toolCallId,
      );
      if (blockIndex < 0) continue;
      const cached = slot.next.get(entry);
      if (cached?.from === slot.message) {
        slot.message = cached.message;
        slot.next = cached.next;
        return;
      }
      const existing = blocks[blockIndex];
      if (!existing) continue;
      const merged = mergedToolMessage(slot.message, blocks, blockIndex, existing, effect);
      const next = new WeakMap<RawEntry, MergeNode>();
      slot.next.set(entry, { from: slot.message, message: merged, next });
      slot.message = merged;
      slot.next = next;
      return;
    }
  }
  slots.push({ message: effect.standalone, next: effect.next });
}

function interpretEntry(entry: RawEntry, hydrationReceiptTime: number): EntryEffect {
  if (entry["type"] === "custom_message") {
    const customType = entry["customType"];
    const content = entry["content"];
    if (typeof customType !== "string" || typeof content !== "string") return skipEffect;
    // Observed engine contract: only custom messages explicitly flagged for
    // display enter the transcript; anything else is dropped.
    const inner = entry["message"];
    const display = entry["display"] ?? (isRecord(inner) ? inner["display"] : undefined);
    if (display !== true) return skipEffect;
    const id = entry["id"];
    return emitEffect({
      ...(typeof id === "string" ? { id } : {}),
      role: "custom",
      customType,
      blocks: [{ kind: "text", text: content }],
      ts: parseTimestamp(entry["timestamp"]),
    });
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
    if (typeof summary !== "string") return skipEffect;
    const id = entry["id"];
    const tokensBefore = entry["tokensBefore"];
    const summaryKind = entry["type"];
    return emitEffect({
      ...(typeof id === "string" ? { id } : {}),
      role: "custom",
      customType: summaryKind,
      summaryKind,
      blocks: [{ kind: "text", text: summary }],
      ts: parseSummaryTimestamp(entry["timestamp"], hydrationReceiptTime),
      ...(summaryKind === "compaction" && typeof tokensBefore === "number" ? { tokensBefore } : {}),
    });
  }
  if (entry["type"] !== "message") return skipEffect;
  const message = entry["message"];
  if (!isRecord(message)) return skipEffect;
  const role = message["role"];
  if (typeof role !== "string") return skipEffect;
  if (role === "toolResult") return toolEffect(message, entry["id"]);
  const timestamp = message["timestamp"];
  const model = message["model"];
  const id = entry["id"];
  // Failure fields observed on the wire for turns that ended
  // unsuccessfully; persisted entries carry them beside content, and they
  // must survive hydration so the failure renders attached to its turn.
  const errorMessage = message["errorMessage"];
  const stopReason = message["stopReason"];
  // Kept in state even with zero blocks: an empty restored completion
  // anchors current-turn tool results exactly like the live path, so
  // parseEntries must not drop it. Blank-row hiding is owned by the
  // presentation seam (ChatTranscript), never by transcript state.
  return emitEffect({
    ...(typeof id === "string" ? { id } : {}),
    role,
    blocks: parseBlocks(message["content"]),
    ts: typeof timestamp === "number" ? timestamp : 0,
    ...(typeof model === "string" ? { model } : {}),
    ...(typeof errorMessage === "string" ? { errorMessage } : {}),
    ...(typeof stopReason === "string" ? { stopReason } : {}),
  });
}

function cachedEffect(entry: RawEntry, hydrationReceiptTime: number): EntryEffect {
  const cached = entryEffects.get(entry);
  if (cached) return cached;
  const effect = interpretEntry(entry, hydrationReceiptTime);
  entryEffects.set(entry, effect);
  return effect;
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

/**
 * Parse committed history entries into transcript messages.
 *
 * Raw entry objects are the cache identity (WeakMap). Re-parsing a list that
 * prepends older entries interprets only those new objects, plus any
 * invocation whose tool-result merge set changed at the seam. Every other
 * UiMessage is the same instance as the previous parse.
 */
export function parseEntries(entries: unknown): UiMessage[] {
  if (!Array.isArray(entries)) return [];
  // Hydration receipt time, frozen once per hydration pass: summary entries
  // with an absent/invalid timestamp fall back to this stable value. Entries
  // already interpreted keep the receipt time from their first parse.
  const hydrationReceiptTime = Date.now();
  const slots: MemoSlot[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const effect = cachedEffect(entry, hydrationReceiptTime);
    if (effect.kind === "skip") continue;
    if (effect.kind === "emit") {
      slots.push({ message: effect.message, next: effect.next });
      continue;
    }
    applyToolEffect(slots, entry, effect);
  }
  const messages: UiMessage[] = [];
  for (const slot of slots) messages.push(slot.message);
  return messages;
}
