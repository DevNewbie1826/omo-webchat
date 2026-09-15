import type {
  AssistantDelta,
  AssistantMessage,
  CommandEntry,
  CommandSourceInfo,
  ContentBlock,
  ContextUsage,
  JsonValue,
  ModelInfo,
  ResumeCandidate,
} from "./contract/types_gen";
import type { ToolPayload, ToolPayloadContentItem } from "./chatWs";

/**
 * Structural validation primitives and nested parsers shared by the inbound
 * frame parser, adapted to the generated contract types: every nested shape
 * (blocks, deltas, tool payloads, command entries, resume candidates, model
 * infos) is now the schema-generated type instead of a hand-rolled twin.
 *
 * Field readers tri-state optional values: undefined = absent, null = present
 * but malformed (so the enclosing frame is rejected), or the narrowed value.
 * Arbitrary provider JSON is sanitized to plain JSON so it can never carry
 * prototype-polluting keys or non-JSON scalars.
 */

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-clone arbitrary input into plain, prototype-pollution-safe JSON. */
export function sanitizeJson(value: unknown): JsonValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item));
  if (isRecord(value)) {
    const out: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value)) {
      if (!FORBIDDEN_KEYS.has(key)) out[key] = sanitizeJson(value[key]);
    }
    return out;
  }
  return null;
}

export function reqString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

export function reqBoolean(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}

export function reqNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" ? value : null;
}

export function optString(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

export function optBoolean(record: Record<string, unknown>, key: string): boolean | null | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? value : null;
}

export function optNumber(record: Record<string, unknown>, key: string): number | null | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === "number" ? value : null;
}

export function parseContextUsage(value: unknown): ContextUsage | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const tokens = optNumber(value, "tokens");
  const contextWindow = optNumber(value, "contextWindow");
  const used = optNumber(value, "used");
  const total = optNumber(value, "total");
  const percent = optNumber(value, "percent");
  if (tokens === null || contextWindow === null || used === null || total === null || typeof percent !== "number") return null;
  return {
    percent,
    ...(tokens !== undefined ? { tokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(total !== undefined ? { total } : {}),
  };
}

export function optStringArray(record: Record<string, unknown>, key: string): readonly string[] | null | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

/** Validate an array whose items must each be a record mapped to T (or null). */
export function mapRecords<T>(value: unknown, map: (item: Record<string, unknown>) => T | null): readonly T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const mapped = map(item);
    if (mapped === null) return null;
    out.push(mapped);
  }
  return out;
}

/**
 * Validate the image_ref pointer field: a record carrying toolCallId and
 * contentIndex, shaped exactly by the generated contract schema.
 */
function parseContentRef(value: unknown): ContentBlock["ref"] | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const toolCallId = reqString(value, "toolCallId");
  const contentIndex = reqNumber(value, "contentIndex");
  if (toolCallId === null || contentIndex === null) return null;
  return { toolCallId, contentIndex };
}

export function parseContentBlock(record: Record<string, unknown>): ContentBlock | null {
  const kind = reqString(record, "kind");
  if (kind === null) return null;
  const text = optString(record, "text");
  const thinking = optString(record, "thinking");
  const id = optString(record, "id");
  const name = optString(record, "name");
  const isError = optBoolean(record, "isError");
  const data = optString(record, "data");
  const mimeType = optString(record, "mimeType");
  const byteLength = optNumber(record, "byteLength");
  const ref = parseContentRef(record["ref"]);
  if (
    text === null || thinking === null || id === null || name === null || isError === null
    || data === null || mimeType === null || byteLength === null || ref === null
  ) {
    return null;
  }
  const args = record["arguments"];
  return {
    kind,
    ...(text !== undefined ? { text } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(isError !== undefined ? { isError } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(byteLength !== undefined ? { byteLength } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...(args !== undefined ? { arguments: sanitizeJson(args) } : {}),
  };
}

export function parseAssistantMessage(record: Record<string, unknown>): AssistantMessage | null {
  const role = reqString(record, "role");
  if (role === null) return null;
  const customType = optString(record, "customType");
  const model = optString(record, "model");
  const explicitTs = optNumber(record, "ts");
  const timestamp = optNumber(record, "timestamp");
  const content = optString(record, "content");
  // Optional failure fields observed on the wire when an assistant turn ends
  // unsuccessfully: absent on healthy turns, so older and replayed frames
  // without them parse exactly as before.
  const errorMessage = optString(record, "errorMessage");
  const stopReason = optString(record, "stopReason");
  if (
    customType === null || model === null || explicitTs === null || timestamp === null || content === null
    || errorMessage === null || stopReason === null
  ) return null;
  const ts = explicitTs ?? timestamp;
  const rawBlocks = record["blocks"];
  const blocks = rawBlocks === undefined
    ? (content === undefined ? undefined : [{ kind: "text", text: content }])
    : mapRecords(rawBlocks, parseContentBlock);
  if (blocks === null) return null;
  const usage = record["usage"];
  const toolCallId = optString(record, "toolCallId");
  if (toolCallId === null) return null;
  // The engine's role "toolResult" messages name their invocation with a
  // message-level toolCallId (stored transcripts carry the same field), but
  // the generated AssistantMessage does not declare it. The merge seam
  // (chatSessionState.mergeToolResultMedia) addresses the live invocation by
  // it, so the seam preserves the field without widening the contract type.
  const parsed: AssistantMessage & { readonly toolCallId?: string } = {
    role,
    ...(customType !== undefined ? { customType } : {}),
    ...(blocks !== undefined ? { blocks } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(ts !== undefined ? { ts } : {}),
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(usage !== undefined ? { usage: sanitizeJson(usage) } : {}),
  };
  return parsed;
}

export function parseAssistantDelta(record: Record<string, unknown>): AssistantDelta | null {
  const kind = reqString(record, "kind");
  if (kind === null) return null;
  const contentIndex = optNumber(record, "contentIndex");
  const delta = optString(record, "delta");
  const content = optString(record, "content");
  const reason = optString(record, "reason");
  if (contentIndex === null || delta === null || content === null || reason === null) return null;
  const partial = record["partial"];
  return {
    kind,
    ...(contentIndex !== undefined ? { contentIndex } : {}),
    ...(delta !== undefined ? { delta } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(partial !== undefined ? { partial: sanitizeJson(partial) } : {}),
  };
}

/**
 * Validate one tool partial/result content item; image fields included. The
 * discriminator is preserved whatever form the server forwarded: the native
 * provider block `type` ("image"/"image_ref") and/or the synthetic `kind`.
 */
function parseToolContentItem(record: Record<string, unknown>): ToolPayloadContentItem | null {
  const type = optString(record, "type");
  const kind = optString(record, "kind");
  const text = optString(record, "text");
  const data = optString(record, "data");
  const mimeType = optString(record, "mimeType");
  const byteLength = optNumber(record, "byteLength");
  const ref = parseContentRef(record["ref"]);
  if (
    type === null || kind === null || text === null || data === null || mimeType === null || byteLength === null || ref === null
  ) {
    return null;
  }
  return {
    ...(type !== undefined ? { type } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(byteLength !== undefined ? { byteLength } : {}),
    ...(ref !== undefined ? { ref } : {}),
  };
}

/** Validate a tool partial/result payload whose content items (text or image)
 * and details are dereferenced. */
export function parseToolPayload(value: unknown): ToolPayload | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const rawContent = value["content"];
  const rawDetails = value["details"];
  const hasDetails = rawDetails !== undefined;
  if (rawContent === undefined && !hasDetails) return {};
  const content = rawContent === undefined ? undefined : mapRecords(rawContent, parseToolContentItem);
  if (content === null) return null;
  return {
    ...(content !== undefined ? { content } : {}),
    ...(hasDetails ? { details: sanitizeJson(rawDetails) } : {}),
  };
}

/** Validate Omo's get_commands sourceInfo record; present-but-malformed rejects. */
export function parseCommandSourceInfo(value: unknown): CommandSourceInfo | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const path = optString(value, "path");
  const baseDir = optString(value, "baseDir");
  const source = optString(value, "source");
  const scope = optString(value, "scope");
  const origin = optString(value, "origin");
  if (path === null || baseDir === null || source === null || scope === null || origin === null) return null;
  return {
    ...(path !== undefined ? { path } : {}),
    ...(baseDir !== undefined ? { baseDir } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(origin !== undefined ? { origin } : {}),
  };
}

export function parseCommandEntry(record: Record<string, unknown>): CommandEntry | null {
  const name = reqString(record, "name");
  if (name === null) return null;
  const description = optString(record, "description");
  const source = optString(record, "source");
  const syntax = optString(record, "syntax");
  const sourceInfo = parseCommandSourceInfo(record["sourceInfo"]);
  if (description === null || source === null || syntax === null || sourceInfo === null) return null;
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(syntax !== undefined ? { syntax } : {}),
    ...(sourceInfo !== undefined ? { sourceInfo } : {}),
  };
}

/**
 * Validate one resume candidate on a resume_failed error frame, shaped exactly
 * by the generated contract schema: id and name are required, hostPath optional.
 */
export function parseResumeCandidate(record: Record<string, unknown>): ResumeCandidate | null {
  const id = reqString(record, "id");
  const name = reqString(record, "name");
  if (id === null || name === null) return null;
  const hostPath = optString(record, "hostPath");
  if (hostPath === null) return null;
  return {
    id,
    name,
    ...(hostPath !== undefined ? { hostPath } : {}),
  };
}

export function parseModelEntry(record: Record<string, unknown>): ModelInfo | null {
  const provider = reqString(record, "provider");
  const modelId = reqString(record, "modelId");
  if (provider === null || modelId === null) return null;
  const name = optString(record, "name");
  if (name === null) return null;
  const rawInput = record["input"];
  const input = Array.isArray(rawInput) ? rawInput.filter((value): value is string => typeof value === "string") : undefined;
  return {
    provider,
    modelId,
    ...(name !== undefined ? { name } : {}),
    ...(input && input.length > 0 ? { input } : {}),
  };
}
