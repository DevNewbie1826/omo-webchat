import { apiResponse } from "./api";

/** Workspace/chat pair that scopes a media fetch (the pane's session identity). */
export interface ChatMediaSource {
  readonly wsId: string;
  readonly chatId: string;
}

/** Server-side media locator carried by an image_ref content block. */
export interface ChatMediaRef {
  readonly toolCallId: string;
  readonly contentIndex: number;
}

/** Same-origin media endpoint; cookie auth rides along via apiResponse. */
export function chatMediaUrl(source: ChatMediaSource, ref: ChatMediaRef): string {
  const base = `/api/workspaces/${encodeURIComponent(source.wsId)}/chats/${encodeURIComponent(source.chatId)}/media`;
  return `${base}?toolCallId=${encodeURIComponent(ref.toolCallId)}&contentIndex=${ref.contentIndex}`;
}

// Object-URL promises cached per (wsId, chatId, toolCallId, contentIndex) so
// disclosure re-renders, virtualized-row remounts, and transcript restores
// never refetch bytes the page already holds. Rejections stay cached too: the
// fallback placeholder is the terminal state for this page lifetime.
const objectUrlCache = new Map<string, Promise<string>>();

/** Fetch the media bytes once and hand back a stable object URL. */
export function fetchChatMediaObjectUrl(source: ChatMediaSource, ref: ChatMediaRef): Promise<string> {
  const key = `${source.wsId}/${source.chatId}/${ref.toolCallId}/${ref.contentIndex}`;
  let cached = objectUrlCache.get(key);
  if (cached === undefined) {
    cached = apiResponse(chatMediaUrl(source, ref))
      .then((res) => res.blob())
      .then((blob) => URL.createObjectURL(blob));
    objectUrlCache.set(key, cached);
  }
  return cached;
}

/** Test hook: drop every cached media promise. */
export function clearChatMediaCache(): void {
  objectUrlCache.clear();
}

/** Human-readable byte size for the unavailable placeholder ("12.3 KB"). */
export function formatByteLength(byteLength: number): string {
  if (!Number.isFinite(byteLength) || byteLength < 0) return "0 B";
  if (byteLength < 1024) return `${byteLength} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = byteLength;
  let unit: string = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}
