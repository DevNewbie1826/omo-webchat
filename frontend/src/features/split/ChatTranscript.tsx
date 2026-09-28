import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type TransitionEvent } from "react";
import { flushSync } from "react-dom";
import { defaultRangeExtractor, measureElement, useVirtualizer } from "@tanstack/react-virtual";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import "../../styles/math.css";
import { useT } from "../../i18n";
import {
  fetchChatMediaObjectUrl,
  formatByteLength,
  type ChatMediaSource,
} from "../../lib/chatMedia";
import type { Paragraph, Root } from "mdast";
import type {} from "mdast-util-math";
import type { UiMessage } from "./chatEntries";
import { hasRenderableContent, isFailedTurn } from "./chatEntries";
import type { ToolEntry, ToolResultImage } from "./chatSessionTypes";
import { HookCard } from "./HookCard";
import { remarkBackslashMath } from "./mathDelimiters";
import { ToolCard, type ToolCardProps } from "./ToolCard";
import { ThinkingDisclosure } from "./ThinkingDisclosure";
import { TranscriptNoticeRow } from "./TranscriptNoticeRow";
import { SummaryNoticeBox } from "./SummaryNoticeBox";
import { useChatScroll } from "./useChatScroll";
import { ModalDialog } from "../../components/ModalDialog";
import { estimateRowHeight, readRowMetrics } from "./chatRowEstimate";
import type { TranscriptItem } from "./useChatFrameState";

function blockKey(block: NonNullable<UiMessage["blocks"]>[number]): string {
  return block.id ?? `${block.kind}:${block.name ?? ""}:${block.text ?? block.thinking ?? ""}:${JSON.stringify(block.arguments ?? null)}`;
}

/** Block kinds that form the tool/thinking/subagent timeline. */
const RECORD_BLOCK_KINDS = new Set(["thinking", "tool", "toolCall", "toolResult"]);

/** True when the block renders as part of a record's media group rather than
 * its own row: result images always belong to the preceding invocation. */
function isRecordMedia(block: NonNullable<UiMessage["blocks"]>[number]): boolean {
  return block.kind === "image" || block.kind === "image_ref";
}

/** The last block that carries its own transcript row, skipping media that
 * renders inside a record's media wrapper; undefined for an empty message. */
function lastRowBlock(message: UiMessage): NonNullable<UiMessage["blocks"]>[number] | undefined {
  const blocks = message.blocks ?? [];
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block !== undefined && !isRecordMedia(block)) return block;
  }
  return undefined;
}

/** Identity of one result image: shared media-ref coordinates or equal bytes. */
function sameMedia(a: ToolResultImage, b: ToolResultImage): boolean {
  if (a.ref !== undefined || b.ref !== undefined) {
    return a.ref?.toolCallId === b.ref?.toolCallId && a.ref?.contentIndex === b.ref?.contentIndex;
  }
  return a.data === b.data;
}

/** Zoom identity of a referenced image: its shared media coordinate. */
function refZoomKey(toolCallId: string, contentIndex: number): string {
  return `ref:${toolCallId}:${contentIndex}`;
}

/** The image carried by an image/image_ref block, if the block is well-formed. */
function blockMedia(block: NonNullable<UiMessage["blocks"]>[number]): ToolResultImage | null {
  if (block.kind !== "image" && block.kind !== "image_ref") return null;
  if (block.data === undefined && block.ref === undefined) return null;
  return {
    ...(block.data !== undefined ? { data: block.data } : {}),
    ...(block.mimeType !== undefined ? { mimeType: block.mimeType } : {}),
    ...(block.byteLength !== undefined ? { byteLength: block.byteLength } : {}),
    ...(block.ref !== undefined ? { ref: block.ref } : {}),
  };
}

function rowText(message: UiMessage): string {
  return (message.blocks ?? [])
    .map((block) => block.text ?? block.thinking ?? "")
    .filter((text) => text.length > 0)
    .join("\n");
}

const STOP_ERROR_REASONS = new Set(["max_tokens", "length", "content_filter", "refusal", "error"]);

/** Wire-provided wording for a failed turn: the failure text exactly as it
 * arrived, else the wire stopReason value itself; null when the wire carried
 * neither (nothing to show — never synthesize a label). */
function failedTurnText(message: UiMessage): string | null {
  if (message.errorMessage !== undefined && message.errorMessage.length > 0) return message.errorMessage;
  return message.stopReason ?? null;
}

function isStopError(reason: string): boolean {
  return STOP_ERROR_REASONS.has(reason);
}

/**
 * remark-math parses a one-line whole-paragraph `$$...$$` as inline math, so
 * without help a standalone display formula would typeset inline. Promote
 * exactly that case to display math by retagging the parsed node; `$$` used
 * mid-sentence stays inline. This reuses the parsed tree and the delimiter
 * width recorded in node positions - it is not a separate parser.
 */
function remarkStandaloneDisplayMath(): (tree: Root) => void {
  const walk = (node: { readonly type: string; readonly children?: readonly unknown[] }): void => {
    for (const child of node.children ?? []) {
      walk(child as { readonly type: string; readonly children?: readonly unknown[] });
    }
    if (node.type !== "paragraph") return;
    const children = (node as unknown as Paragraph).children;
    if (children.length !== 1) return;
    const child = children[0];
    if (child?.type !== "inlineMath" || child.position === undefined) return;
    if ((child.data as { readonly backslashDelimiter?: string } | undefined)?.backslashDelimiter === "(") return;
    const { start, end } = child.position;
    if (start.offset === undefined || end.offset === undefined) return;
    // `$$` fences are two columns wider per side than `$` fences.
    if (end.offset - start.offset - child.value.length !== 4) return;
    child.data = {
      ...child.data,
      hProperties: {
        ...(child.data?.hProperties as Record<string, unknown> | undefined),
        className: ["language-math", "math-display"],
      },
    };
  };
  return (tree) => walk(tree);
}

// One Markdown seam for finalized blocks and the streaming buffer alike, so
// both render math identically. remark-math only pairs balanced $...$/$$...$$
// delimiters, so a half-typed formula mid-stream stays literal text; a
// malformed but delimited one is rendered back as source inline by KaTeX
// (throwOnError: false) instead of throwing or blanking the transcript.
// Models also emit \[...\] / \(...\) delimiters, which CommonMark consumes as
// bracket escapes. After remark-math has registered dollar-math parsing,
// remarkBackslashMath recovers balanced pairs from text-node source positions
// and creates math nodes directly; the display promotion then handles both
// existing standalone $$ nodes and backslash-bracket display nodes.
const Markdown = memo(({ text }: { readonly text: string }) => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm, remarkMath, remarkBackslashMath, remarkStandaloneDisplayMath]}
    rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
  >
    {text}
  </ReactMarkdown>
));

/** Presentational only (DESIGN.md "Conversation anatomy"): true when the
 * message at `index` is the first user message after other content, so the
 * row can open the taller before-user-turn gap. Purely derived from the
 * rendered item list; never reorders or filters the transcript. */
export function userTurnStart(items: readonly TranscriptItem[], index: number): boolean {
  const item = items[index];
  if (!item || item.kind !== "message" || item.message.role !== "user") return false;
  const previous = items[index - 1];
  return !previous || previous.kind !== "message" || previous.message.role !== "user";
}

const clientMessageKeys = new WeakMap<UiMessage, string>();

export function transcriptItemKeys(items: readonly TranscriptItem[]): readonly string[] {
  return items.map((item) => {
    if (item.kind === "notice") return `notice:${item.notice.id}`;
    const message = item.message;
    if (message.id !== undefined) return `message:${message.id}`;
    // Live messages retain their object until replaced by authoritative
    // entries. Their identity must not depend on where history inserts them.
    let key = clientMessageKeys.get(message);
    if (key === undefined) {
      key = `client:${crypto.randomUUID()}`;
      clientMessageKeys.set(message, key);
    }
    return key;
  });
}

const MISSING_ROW: TranscriptItem = {
  kind: "message",
  message: { role: "assistant", blocks: [] },
};

/** Stable logical identity of a zoomed image's trigger, threaded onto the
 * button as data-zoom-key so a close-time re-resolution never has to match
 * on the raw <img> src (ambiguous when two images share bytes). Referenced
 * images resolve by their media coordinate; inline images by the block/media
 * key already used as the React key. */
type ZoomOpen = (src: string, trigger: HTMLElement) => void;

/** Inline image carried on a preserved block: bytes already inline as base64. */
function InlineImage({ data, mimeType, alt, zoomKey, onZoom }: {
  readonly data: string;
  readonly mimeType: string | undefined;
  readonly alt: string;
  readonly zoomKey: string;
  readonly onZoom: ZoomOpen;
}) {
  const { t } = useT();
  const src = `data:${mimeType ?? "image/png"};base64,${data}`;
  return (
    <button type="button" className="th-chat-image-button" data-zoom-key={zoomKey} aria-label={t("chat.imageZoom")} onClick={(event) => onZoom(src, event.currentTarget)}>
      <img
        className="th-chat-image"
        src={src}
        alt={alt}
        loading="lazy"
      />
    </button>
  );
}

/** Failure placeholder: exact mimeType + formatted byteLength, never a blank. */
function ImageUnavailable({ mimeType, byteLength }: {
  readonly mimeType: string | undefined;
  readonly byteLength: number | undefined;
}) {
  const { t } = useT();
  return (
    <div className="th-chat-image-unavailable" role="img" aria-label={t("chat.imageUnavailable")}>
      <span className="th-chat-image-meta">
        {mimeType ?? t("chat.image")} · {formatByteLength(byteLength ?? 0)}
      </span>
      <span className="th-chat-image-note">{t("chat.imageUnavailable")}</span>
    </div>
  );
}

/**
 * Referenced image: bytes live server-side, so the fetch is deferred until the
 * image element actually enters the viewport (IntersectionObserver) — mounting
 * inside a collapsed card's media wrapper alone never requests anything. The
 * object URL is cached per (wsId, chatId, toolCallId, contentIndex) in
 * chatMedia.ts, so re-renders, disclosure toggles, and virtualized-row or full
 * remounts never refetch; a rejection stays cached too, leaving the fallback.
 */
function RefImage({ source, toolCallId, contentIndex, mimeType, byteLength, onZoom }: {
  readonly source: ChatMediaSource | undefined;
  readonly toolCallId: string;
  readonly contentIndex: number;
  readonly mimeType: string | undefined;
  readonly byteLength: number | undefined;
  readonly onZoom: ZoomOpen;
}) {
  const { t } = useT();
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // Whichever element currently represents the image (pending frame, loaded
  // <img>, or fallback) — the observer needs a real element at effect time.
  const observedRef = useRef<HTMLElement | null>(null);
  const observeElement = (element: HTMLElement | null): void => {
    observedRef.current = element;
  };
  const wsId = source?.wsId;
  const chatId = source?.chatId;
  useEffect(() => {
    const element = observedRef.current;
    if (element === null) return;
    let active = true;
    const fetchWhenVisible = (): void => {
      if (wsId === undefined || chatId === undefined) {
        setFailed(true);
        return;
      }
      fetchChatMediaObjectUrl({ wsId, chatId }, { toolCallId, contentIndex }).then(
        (url) => {
          if (active) setObjectUrl(url);
        },
        () => {
          if (active) setFailed(true);
        },
      );
    };
    if (typeof IntersectionObserver !== "function") {
      // No viewport signal available: the row is mounted, so treat it as
      // visible rather than never showing the image.
      fetchWhenVisible();
      return () => {
        active = false;
      };
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      fetchWhenVisible();
    });
    observer.observe(element);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [wsId, chatId, toolCallId, contentIndex]);
  if (objectUrl !== null) {
    return (
      <button type="button" className="th-chat-image-button" data-zoom-key={refZoomKey(toolCallId, contentIndex)} aria-label={t("chat.imageZoom")} onClick={(event) => onZoom(objectUrl, event.currentTarget)}>
        <img ref={observeElement} className="th-chat-image" src={objectUrl} alt={t("chat.image")} loading="lazy" />
      </button>
    );
  }
  if (failed) return <ImageUnavailable mimeType={mimeType} byteLength={byteLength} />;
  // Pending frame: reserves the thumbnail box until the image enters the
  // viewport and its (cached) bytes arrive. It is the observed element.
  return <div ref={observeElement} className="th-chat-image th-chat-image-pending" />;
}

interface ChatTranscriptProps {
  /** Unified render list: conversation entries merged with notice blocks. */
  readonly items: readonly TranscriptItem[];
  /** Workspace/chat identity for lazy image_ref media fetches. */
  readonly mediaSource?: ChatMediaSource | undefined;
  readonly streaming: string;
  readonly thinking: string;
  readonly toolCalls: Readonly<Record<string, ToolEntry>>;
  readonly doneReason: string | null;
  readonly error: string;
  readonly restoreVersion: number;
  readonly focused: boolean;
  readonly historyLoaded: boolean;
  /** On-demand older-history loader owned by the session hook. The top
   * sentinel calls loadOlder() when the reader scrolls into it and is not
   * bottom-following; absent where no older history can exist (tests). */
  readonly olderHistory?: { readonly state: OlderHistoryViewState; readonly loadOlder: () => void };
  /** History failed with zero committed messages: an inline, retryable
   * status row renders at the top of the transcript; notices still render
   * below it. */
  readonly historyFailedEmpty?: boolean;
  /** Retry callback for the failed-empty row (resync/recreate history). */
  readonly onRetryHistory?: () => void;
}

export type OlderHistoryViewState = "idle" | "loading" | "error" | "complete" | "unavailable";

export function ChatTranscript({
  items,
  streaming,
  thinking,
  toolCalls,
  doneReason,
  error,
  restoreVersion,
  focused,
  historyLoaded,
  olderHistory,
  historyFailedEmpty = false,
  onRetryHistory,
  mediaSource,
}: ChatTranscriptProps) {
  const { t, fontSize, font } = useT();
  const imageZoomTitleId = useId();
  // Measurement corrections dropped while a user scroll gesture is in flight
  // accumulate here and replay once the gesture ends (scrollend listener /
  // debounced-scroll fallback below). Declared before useChatScroll so an
  // explicit scroll-to-bottom intent can discard a queued replay.
  const deferredAdjustmentRef = useRef(0);
  const clearDeferredAdjustment = useCallback(() => {
    deferredAdjustmentRef.current = 0;
  }, []);
  const { scrollRef, contentRef, showScrollToBottom, onScroll, scrollToBottom, holdDisclosurePosition, isFollowing, isReaderInputActive, noteProgrammaticWrite, isRecentProgrammaticWrite } = useChatScroll(restoreVersion, focused, clearDeferredAdjustment);
  // On-demand older history (G9 view): a sentinel above the virtualized rows
  // is observed against the scrollport with a 600px top margin. When it
  // enters the margin and the reader is not bottom-following, the next page
  // loads. The observer only fires on crossings, so each landing while the
  // reader parks inside the margin re-checks manually to keep paging.
  const olderState = olderHistory?.state ?? "complete";
  const sentinelMounted = olderHistory !== undefined && olderState !== "complete" && olderState !== "unavailable";
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const sentinelInViewRef = useRef(false);
  const olderHistoryRef = useRef(olderHistory);
  olderHistoryRef.current = olderHistory;
  const maybeLoadOlder = useCallback((upwardIntent = false) => {
    const handle = olderHistoryRef.current;
    if (!historyLoaded || handle === undefined || handle.state !== "idle") return;
    const scrollport = scrollRef.current;
    // A short/empty tail cannot emit an upward scroll. Only its explicit
    // wheel, touch or keyboard path may request a page, never mount/resize
    // or the previous page's idle transition.
    if (!upwardIntent && (isFollowing() || scrollport === null
      || scrollport.scrollHeight <= scrollport.clientHeight)) return;
    // The hook owns synchronous single-flight admission. It may decline
    // while disconnected, so a view-side pending flag can never be sound.
    handle.loadOlder();
  }, [historyLoaded, isFollowing, scrollRef]);
  useEffect(() => {
    const scrollport = scrollRef.current;
    if (!sentinelMounted || scrollport === null) return;
    const readUp = (): void => {
      if (!historyLoaded || scrollport.scrollHeight > scrollport.clientHeight) return;
      holdDisclosurePosition();
      maybeLoadOlder(true);
    };
    const wheel = (event: WheelEvent): void => { if (event.deltaY < 0) readUp(); };
    let touchY: number | null = null;
    const touchStart = (event: TouchEvent): void => { touchY = event.touches[0]?.clientY ?? null; };
    const touchMove = (event: TouchEvent): void => {
      const nextY = event.touches[0]?.clientY;
      if (nextY === undefined) return;
      if (touchY !== null && nextY > touchY) readUp();
      touchY = nextY;
    };
    const keyDown = (event: KeyboardEvent): void => {
      if (event.target === scrollport && ["PageUp", "Home", "ArrowUp"].includes(event.key)) readUp();
    };
    scrollport.addEventListener("wheel", wheel, { passive: true });
    scrollport.addEventListener("touchstart", touchStart, { passive: true });
    scrollport.addEventListener("touchmove", touchMove, { passive: true });
    scrollport.addEventListener("keydown", keyDown);
    return () => {
      scrollport.removeEventListener("wheel", wheel);
      scrollport.removeEventListener("touchstart", touchStart);
      scrollport.removeEventListener("touchmove", touchMove);
      scrollport.removeEventListener("keydown", keyDown);
    };
  }, [sentinelMounted, historyLoaded, scrollRef, holdDisclosurePosition, maybeLoadOlder]);
  useEffect(() => {
    if (!sentinelMounted) return;
    const element = sentinelRef.current;
    const scrollport = scrollRef.current;
    if (element === null || scrollport === null || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry === undefined) return;
      sentinelInViewRef.current = entry.isIntersecting;
      if (entry.isIntersecting) maybeLoadOlder();
    }, { root: scrollport, rootMargin: "600px 0px 0px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [sentinelMounted, scrollRef, maybeLoadOlder]);
  useEffect(() => {
    if (!sentinelMounted || olderState !== "idle") return;
    const element = sentinelRef.current;
    const scrollport = scrollRef.current;
    if (element === null || scrollport === null) return;
    const rootRect = scrollport.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const topMargin = 600;
    if (rect.bottom < rootRect.top - topMargin || rect.top > rootRect.bottom) return;
    maybeLoadOlder();
  }, [sentinelMounted, olderState, scrollRef, maybeLoadOlder]);
  // Lane width feeding the row-height estimator. Tracked via ResizeObserver
  // so metrics recompute only on an actual width change, never per render.
  const [laneWidth, setLaneWidth] = useState(0);
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const update = () => setLaneWidth(element.clientWidth);
    update();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollRef]);
  // Row metrics must be read AFTER useAppConfig writes --th-font-size /
  // --th-font-mono in its effect. Child effects run first, so wait for the
  // rest of this commit's effects via a microtask, then replace estimates
  // and re-render so the virtualizer rebuilds from the new geometry.
  const [rowMetrics, setRowMetrics] = useState(() => readRowMetrics(null));
  // Stable per-row estimates, keyed by the virtual row key: a row's estimate
  // is computed ONCE and never changes afterwards, so content arriving for
  // rows the reader has never seen cannot shift the scroll position (the
  // virtualizer compensates only for MEASURED changes, never for a changed
  // estimate of an unmeasured row). Once a row actually renders, the
  // virtualizer's own measurement supersedes the frozen estimate.
  // Replace the cache only in the render that installs changed metrics. A
  // repeated metrics read can return the same object and cause no render.
  const estimateCache = useMemo(() => new Map<string, number>(), [rowMetrics]);
  useEffect(() => {
    let cancelled = false;
    const syncMetrics = (): void => {
      if (cancelled) return;
      const next = readRowMetrics(scrollRef.current);
      setRowMetrics(next);
    };
    queueMicrotask(syncMetrics);
    return () => {
      cancelled = true;
    };
  }, [laneWidth, fontSize, font]);
  // USER CHOICES only: presence in the map means the user toggled that card
  // (the value is their frozen choice). Absent ids are untouched and pass no
  // `open`, so ToolCard derives the disclosure from the card's CURRENT live
  // status on every render — virtualized history rows can unmount and remount
  // freely without latching a stale initial phase.
  const toolDisclosureRef = useRef(new Map<string, boolean>());
  const [, setToolDisclosureVersion] = useState(0);
  const rememberedToolCard = (props: ToolCardProps) => (
    <ToolCard
      key={props.toolCallId}
      {...props}
      open={toolDisclosureRef.current.get(props.toolCallId)}
      onOpenChange={(next) => {
        toolDisclosureRef.current.set(props.toolCallId, next);
        setToolDisclosureVersion((version) => version + 1);
      }}
    />
  );
  // Zoomed image source for the media modal. Only the src is kept: the
  // modal renders through a portal, so virtualized row unmounts never tear
  // it down, and reusing the same data:/object URL never refetches.
  const [zoomedSrc, setZoomedSrc] = useState<string | null>(null);
  // The originating trigger element plus its stable logical identity,
  // captured when the zoom opens. modalStack restores focus to the element
  // that was active when the modal opened, so while that element is still
  // connected the close path does NOTHING extra — re-resolving by <img> src
  // would both override the correct restoration and mis-target the first of
  // two byte-identical images. Only a live row finalizing underneath the
  // open zoom replaces the trigger node; then the saved element is
  // disconnected and the CURRENT trigger is re-resolved by its data-zoom-key
  // (never by the ambiguous raw src) after the modal's own restore has run
  // (passive-effect destroys all flush before creates).
  const zoomOriginRef = useRef<{ element: HTMLElement; key: string } | null>(null);
  const openZoom = useCallback((src: string, trigger: HTMLElement) => {
    zoomOriginRef.current = { element: trigger, key: trigger.dataset["zoomKey"] ?? "" };
    setZoomedSrc(src);
  }, []);
  const closeZoom = useCallback(() => {
    setZoomedSrc(null);
  }, []);
  useEffect(() => {
    if (zoomedSrc !== null) return;
    const origin = zoomOriginRef.current;
    if (origin === null) return;
    zoomOriginRef.current = null;
    // Normal case: the opener survived, modalStack already restored focus.
    if (origin.element.isConnected) return;
    const root = scrollRef.current;
    if (root === null || origin.key === "") return;
    const trigger = Array.from(root.querySelectorAll<HTMLElement>(".th-chat-image-button"))
      .find((button) => button.dataset["zoomKey"] === origin.key);
    trigger?.focus();
  }, [zoomedSrc, scrollRef]);
  const renderMedia = (media: ToolResultImage, key: string, inlineZoomKey: string) => {
    if (media.data !== undefined) {
      return <InlineImage key={key} data={media.data} mimeType={media.mimeType} alt={t("chat.image")} zoomKey={inlineZoomKey} onZoom={openZoom} />;
    }
    if (media.ref !== undefined) {
      return (
        <RefImage
          key={key}
          source={mediaSource}
          toolCallId={media.ref.toolCallId}
          contentIndex={media.ref.contentIndex}
          mimeType={media.mimeType}
          byteLength={media.byteLength}
          onZoom={openZoom}
        />
      );
    }
    return null;
  };
  // Per-message block rendering. Result images that immediately follow a tool
  // block belong to that invocation's disclosure: they render inside the
  // tool's media wrapper as soon as the row mounts, whether the card is open
  // or collapsed. Laziness lives in RefImage's viewport gate, not in the
  // disclosure state, so a collapsed card still shows its result image.
  // `continuesFromPrevious` marks a record whose rail continues the record
  // run from the previous transcript item (one turn spans multiple
  // messages); within the message each record derives continuation from its
  // previous row-carrying block.
  const renderMessageBlocks = (message: UiMessage, rowKey: string, continuesFromPrevious: boolean): ReactNode[] => {
    const blocks = message.blocks ?? [];
    const groupedResultImages = new Set<number>();
    const continuesRailAt = (blockIndex: number): boolean => {
      for (let prev = blockIndex - 1; prev >= 0; prev -= 1) {
        const block = blocks[prev];
        if (block === undefined || isRecordMedia(block)) continue;
        return RECORD_BLOCK_KINDS.has(block.kind);
      }
      return continuesFromPrevious;
    };
    return blocks.map((block, blockIndex) => {
      if ((block.kind === "image" || block.kind === "image_ref") && groupedResultImages.has(blockIndex)) return null;
      if (block.kind === "thinking") {
        return (
          <ThinkingDisclosure
            key={blockKey(block)}
            text={block.thinking ?? block.text ?? ""}
            continuesRail={continuesRailAt(blockIndex)}
          />
        );
      }
      if (block.kind === "image" && typeof block.data === "string") {
        return (
          <InlineImage
            key={blockKey(block)}
            data={block.data}
            mimeType={block.mimeType}
            alt={t("chat.image")}
            zoomKey={`block:${rowKey}:${blockIndex}`}
            onZoom={openZoom}
          />
        );
      }
      if (block.kind === "image_ref" && block.ref !== undefined) {
        return (
          <RefImage
            key={blockKey(block)}
            source={mediaSource}
            toolCallId={block.ref.toolCallId}
            contentIndex={block.ref.contentIndex}
            mimeType={block.mimeType}
            byteLength={block.byteLength}
            onZoom={openZoom}
          />
        );
      }
      if (block.kind === "tool" || block.kind === "toolCall" || block.kind === "toolResult") {
        // A live result streaming for this disclosure's call id
        // finalizes it in place: show the live phase/output so
        // the invocation renders one card, not a detached twin.
        const live = block.id ? toolCalls[block.id] : undefined;
        const cardId = block.id ?? blockKey(block);
        const isError = live?.isError ?? block.isError ?? false;
        const card = rememberedToolCard({
          toolCallId: cardId,
          toolName: block.name ?? live?.toolName ?? "",
          phase: live?.phase ?? "end",
          text: live ? live.text : block.text ?? "",
          isError,
          details: live?.details,
          args: live?.args ?? block.arguments,
          continuesRail: continuesRailAt(blockIndex),
        });
        // Every result image of this call — the one folded onto the tool
        // block plus the additional ones stored after it — renders inside
        // the disclosure regardless of its open/closed state. An image_ref
        // requests bytes only once its element enters the viewport.
        const extras: ToolResultImage[] = [];
        for (let next = blockIndex + 1; next < blocks.length; next += 1) {
          const extra = blockMedia(blocks[next]!);
          if (extra === null) break;
          groupedResultImages.add(next);
          extras.push(extra);
        }
        const hasFolded = (typeof block.data === "string" && block.data.length > 0) || block.ref !== undefined;
        const blockList: readonly ToolResultImage[] = hasFolded
          ? [{
              ...(typeof block.data === "string" && block.data.length > 0 ? { data: block.data } : {}),
              ...(block.mimeType !== undefined ? { mimeType: block.mimeType } : {}),
              ...(block.byteLength !== undefined ? { byteLength: block.byteLength } : {}),
              ...(block.ref !== undefined ? { ref: block.ref } : {}),
            }, ...extras]
          : extras;
        // A result streaming for this anchored invocation carries its media
        // on the live entry: the persisted blocks predate the result, so the
        // disclosure must surface live.media too or expanding the anchored
        // card would show no image and issue no request. Media already folded
        // into the blocks (a mid-run replay) renders once.
        const liveMedia = (live?.media ?? []).filter((image) => !blockList.some((existing) => sameMedia(existing, image)));
        const media: readonly ToolResultImage[] = [...blockList, ...liveMedia];
        if (media.length === 0) return card;
        const mediaKey = blockKey(block);
        return (
          <div key={mediaKey} className="th-chat-tool-media">
            {card}
            {media.map((image, mediaIndex) => renderMedia(image, `${mediaKey}:${mediaIndex}`, `media:${block.id ?? mediaKey}:${mediaIndex}`))}
          </div>
        );
      }
      return message.role === "assistant" ? (
        <div key={blockKey(block)} className="th-chat-markdown">
          <Markdown text={block.text ?? ""} />
        </div>
      ) : (
        <span key={blockKey(block)}>{block.text}</span>
      );
    });
  };
  // Tool call ids already disclosed inside a history message. A live result
  // streaming for one of these ids must finalize that disclosure in place
  // (below) rather than render a second card in the live region.
  const historyToolIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of items) {
      if (item.kind !== "message") continue;
      for (const block of item.message.blocks ?? []) {
        if (block.id && (block.kind === "tool" || block.kind === "toolCall" || block.kind === "toolResult")) {
          ids.add(block.id);
        }
      }
    }
    return ids;
  }, [items]);

  useEffect(() => {
    const retainedIds = new Set([...historyToolIds, ...Object.keys(toolCalls)]);
    for (const id of toolDisclosureRef.current.keys()) {
      if (!retainedIds.has(id)) toolDisclosureRef.current.delete(id);
    }
  }, [historyToolIds, toolCalls]);

  // Anchor for rows arriving at the FRONT of the list (a backward warm chunk
  // of earlier history). It names the first row that is NOT part of that
  // chunk, with the row's index and the height of everything above it as of
  // the last compensation; the effect below holds that row still while the
  // block above it grows. Null whenever no warm chunk is settling.
  const leadingKeyRef = useRef<string | undefined>(undefined);
  const previousStartsRef = useRef(new Map<string, number>());
  const anchorRef = useRef<{ readonly key: string; readonly index: number; readonly start: number } | null>(null);
  // Keep the old window mounted while a prepend's new rows measure. Rendering
  // only the estimated window can evict the reader's DOM before compensation.
  const measuringPrependRef = useRef<readonly string[]>([]);
  const retainedWindowRef = useRef<readonly string[]>([]);
  const prependViewportRef = useRef<{
    readonly key: string;
    readonly top: number;
    readonly started: number;
    frames: number;
  } | null>(null);
  const followMeasurementRef = useRef(false);
  const measuredRowsRef = useRef(new WeakMap<Element, number>());
  const historyRef = useRef<HTMLDivElement>(null);
  // Row identity is assigned over the FULL merged list before any hiding:
  // an empty assistant completion (invisible but state-retained as a
  // current-turn tool anchor) retains its own identity, so
  // it materializing a tool row — or appearing or disappearing — never
  // shifts any other row's key and no visible row remounts. Only after
  // identity assignment are zero-renderable-block rows hidden from the
  // virtualized window.
  const committedIdentityRef = useRef<{
    readonly items: readonly TranscriptItem[];
    readonly keys: readonly string[];
  }>({ items: [], keys: [] });
  const itemKeys = useMemo(() => {
    const canonical = transcriptItemKeys(items);
    const previous = committedIdentityRef.current;
    const previousCanonical = transcriptItemKeys(previous.items);
    const currentIds = new Set(canonical);
    const retained = new Map(previousCanonical.map((key, index) => [key, previous.keys[index] ?? key]));
    const foldedTools = new Map<string, string>();
    const scroll = scrollRef.current;
    const visibleKey = [...scroll?.querySelectorAll<HTMLElement>(".th-chat-row[data-entry-key]") ?? []]
      .find((row) => row.getBoundingClientRect().bottom > (scroll?.getBoundingClientRect().top ?? 0))?.dataset["entryKey"];
    previous.items.forEach((item, index) => {
      if (item.kind !== "message" || currentIds.has(previousCanonical[index] ?? "")) return;
      const key = previous.keys[index];
      if (key === undefined) return;
      for (const block of item.message.blocks ?? []) {
        if (block.id === undefined || !["tool", "toolCall", "toolResult"].includes(block.kind)) continue;
        if (!foldedTools.has(block.id) || key === visibleKey) foldedTools.set(block.id, key);
      }
    });
    // A standalone result at a page boundary becomes part of its invocation.
    // Keep its presentation identity, not its canonical message id (which
    // reconciliation still needs). Existing invocations always keep their key.
    const claimed = new Set(canonical.flatMap((key) => retained.get(key) ?? []));
    return items.map((item, index) => {
      const key = canonical[index] ?? "missing";
      const existing = retained.get(key);
      if (existing !== undefined) return existing;
      if (item.kind !== "message") return key;
      const candidates = (item.message.blocks ?? []).flatMap((block) =>
        block.id === undefined ? [] : foldedTools.get(block.id) ?? []);
      const inherited = candidates.find((candidate) => candidate === visibleKey && !claimed.has(candidate))
        ?? candidates.find((candidate) => !claimed.has(candidate));
      if (inherited === undefined) return key;
      claimed.add(inherited);
      return inherited;
    });
  }, [items, scrollRef]);
  useLayoutEffect(() => {
    committedIdentityRef.current = { items, keys: itemKeys };
  }, [items, itemKeys]);
  const { rows, keys } = useMemo(() => {
    const allKeys = itemKeys;
    const rows: TranscriptItem[] = [];
    const keys: string[] = [];
    items.forEach((item, index) => {
      const key = allKeys[index]!;
      // Freeze at first key appearance, not at the virtualizer's first request.
      if (!estimateCache.has(key)) estimateCache.set(key, estimateRowHeight(item, rowMetrics));
      if (item.kind === "message" && !hasRenderableContent(item.message)) return;
      rows.push(item);
      keys.push(key);
    });
    // Bound the estimate cache: drop entries whose keys left the transcript.
    // Done here, where the key list recomputes, so estimateSize itself stays
    // a pure lookup.
    const live = new Set(allKeys);
    for (const key of estimateCache.keys()) {
      if (!live.has(key)) estimateCache.delete(key);
    }
    // Validate an armed anchor before fallback selection. A later warm chunk
    // can fold its orphan row away too: use the nearest retained row on the
    // following side of the old seam. A preceding warm row would miss the
    // removed row's height. Use a predecessor only if no successor survives.
    const anchor = anchorRef.current;
    if (anchor !== null) {
      const index = keys.indexOf(anchor.key);
      if (index >= 0) {
        anchorRef.current = { ...anchor, index };
      } else {
        const committed = previousStartsRef.current.get(anchor.key) ?? anchor.start;
        const pending = committed - anchor.start;
        let nearest = Infinity;
        let foundSuccessor = false;
        anchorRef.current = null;
        keys.forEach((key, index) => {
          const start = previousStartsRef.current.get(key);
          if (start === undefined) return;
          const successor = start >= committed;
          const distance = Math.abs(start - committed);
          if (foundSuccessor && !successor) return;
          if (successor === foundSuccessor && distance > nearest) return;
          nearest = distance;
          foundSuccessor = successor;
          // Preserve any correction the old anchor could not apply while the
          // DOM sizer lagged behind its committed measurement position.
          anchorRef.current = { key, index, start: start - pending };
        });
      }
    }
    // A warm chunk can fold the old leading orphan tool result into its
    // newly loaded invocation. Anchor the first surviving row instead, using
    // its committed start (not zero). A replaced chat has no surviving row.
    const leading = keys[0];
    if (leading !== leadingKeyRef.current) {
      const seam = keys.findIndex((key) => previousStartsRef.current.has(key));
      const key = keys[seam];
      const start = key === undefined ? undefined : previousStartsRef.current.get(key);
      if (seam > 0 && key !== undefined && start !== undefined) {
        const needsAnchor = anchorRef.current === null;
        if (needsAnchor) {
          anchorRef.current = { key, index: seam, start };
        }
        if (!isFollowing()) {
          const mounted = [...scrollRef.current?.querySelectorAll<HTMLElement>(".th-chat-row[data-entry-key]") ?? []];
          const top = scrollRef.current?.scrollTop ?? 0;
          const visible = mounted.find((row) => {
            const rowKey = row.dataset["entryKey"];
            const rowStart = rowKey === undefined ? undefined : previousStartsRef.current.get(rowKey);
            return rowStart !== undefined && rowStart + row.offsetHeight > top
              && rowKey !== undefined && keys.includes(rowKey);
          });
          const visibleKey = visible?.dataset["entryKey"];
          const visibleStart = visibleKey === undefined ? undefined : previousStartsRef.current.get(visibleKey);
          if (visible !== undefined && visibleKey !== undefined) {
            prependViewportRef.current = {
              key: visibleKey,
              top: visible.getBoundingClientRect().top - (scrollRef.current?.getBoundingClientRect().top ?? 0),
              started: performance.now(),
              frames: 0,
            };
          }
          if (needsAnchor && visibleKey !== undefined && visibleStart !== undefined) {
            anchorRef.current = { key: visibleKey, index: keys.indexOf(visibleKey), start: visibleStart };
          }
          retainedWindowRef.current = mounted.flatMap((row) => row.dataset["entryKey"] ?? []);
          measuringPrependRef.current = keys.slice(0, seam);
        }
      }
      leadingKeyRef.current = leading;
    }
    return { rows, keys };
  }, [items, itemKeys, rowMetrics, estimateCache]);

  // New-row entrance (chat-transcript.css .th-chat-enter): applied once per
  // new entry identity — appended live rows only, never history loads or
  // virtualizer remounts. The first keys snapshot marks the loaded history
  // as animation-free; a restoreVersion change (session switch/restore)
  // resets the snapshot so a fresh history never animates. The class lands
  // on the message content, not the positioned row wrapper: the wrapper's
  // inline transform positions the virtual row and must stay untouched.
  const restoreVersionForEnterRef = useRef(restoreVersion);
  const initialEnterKeysRef = useRef<Set<string> | null>(null);
  const enteredKeysRef = useRef<Set<string>>(new Set());
  if (restoreVersionForEnterRef.current !== restoreVersion) {
    restoreVersionForEnterRef.current = restoreVersion;
    initialEnterKeysRef.current = null;
    enteredKeysRef.current.clear();
  }
  if (initialEnterKeysRef.current === null) initialEnterKeysRef.current = new Set(keys);
  const enterClassFor = (key: string): string => {
    const initial = initialEnterKeysRef.current;
    if (initial === null || initial.has(key) || enteredKeysRef.current.has(key)) return "";
    enteredKeysRef.current.add(key);
    return " th-chat-enter";
  };
  // Include rowMetrics so a typography/width update rebuilds measurements
  // in the same render that installs the new estimates. Content-only
  // updates still hit the frozen per-key estimate cache; measured sizes
  // in the virtualizer's itemSizeCache continue to win.
  const getItemKey = useCallback(
    (index: number) => keys[index] ?? "missing",
    [keys, rowMetrics],
  );
  const measuringPrepend = measuringPrependRef.current;
  const retainedWindow = retainedWindowRef.current;
  const restoringAnchorRef = useRef(false);
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const indexes = new Set(defaultRangeExtractor(range));
    for (const key of [...measuringPrepend, ...retainedWindow]) {
      const index = keys.indexOf(key);
      if (index >= 0) indexes.add(index);
    }
    return [...indexes].sort((a, b) => a - b);
  }, [keys, measuringPrepend, retainedWindow]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getItemKey,
    rangeExtractor,
    getScrollElement: () => scrollRef.current,
    measureElement: (element, entry, instance) => {
      const size = measureElement(element, entry, instance);
      const previous = measuredRowsRef.current.get(element);
      measuredRowsRef.current.set(element, size);
      if (entry !== undefined && previous !== undefined && previous !== size
        && isFollowing() && !isReaderInputActive()) followMeasurementRef.current = true;
      return size;
    },
    // Total: the virtualizer can ask about an index after the row list
    // shrinks (chat switch). A miss still returns a content-derived
    // estimate — never undefined, never a magic constant.
    estimateSize: (index) => {
      const key = keys[index];
      if (key !== undefined) {
        const cached = estimateCache.get(key);
        if (cached !== undefined) return cached;
        const item = rows[index];
        if (item !== undefined) {
          const size = estimateRowHeight(item, rowMetrics);
          estimateCache.set(key, size);
          return size;
        }
      }
      return estimateRowHeight(MISSING_ROW, rowMetrics);
    },
    overscan: 8,
    // Undefined adjustments are NOT proof of explicit intent: virtual-core
    // also retries clamped measurement writes through that path. Preserve
    // gesture deferral there too; a programmatic write can kill a fling.
    scrollToFn: (offset, { adjustments, behavior }, instance) => {
      const element = instance.scrollElement;
      if (element === null) return;
      if (adjustments === undefined) {
        // These calls also include later animation-frame reconciliation of
        // scrollToIndex, not just its initial intent. After a prepend that
        // saved numeric index addresses an earlier row. The reader may have
        // parked since the request: only current follow intent authorizes the
        // write (jump/focus/restore hand that intent back before positioning).
        // A rejected stale request must not discard measurement compensation.
        if (!isFollowing() && !restoringAnchorRef.current) return;
        // Explicit jump/focus/restore relinquishes reader ownership and clears
        // our queue in scrollToBottom. A library retry does neither. Its delta
        // is already queued: do not write it early or accumulate it twice.
        if (instance.isScrolling && deferredAdjustmentRef.current !== 0) return;
        const previous = element.scrollTop;
        element.scrollTo?.(behavior === undefined ? { top: offset } : { top: offset, behavior });
        if (element.scrollTop !== previous) noteProgrammaticWrite("measurement");
        return;
      }
      // virtual-core 3.17.6 hands over the PER-CALL delta on every path, never
      // a running total: the non-iOS applyScrollAdjustment resets its internal
      // scrollAdjustments counter to 0 immediately after each call, the iOS
      // deferred flush starts from a counter zeroed by the touch-end scroll
      // events, and every observed scroll event zeroes it as well. Apply each
      // delta exactly once — do NOT diff against a remembered previous value.
      if (instance.isScrolling) {
        // Dropped while the gesture is in flight — never written now, but
        // accumulated so it replays once the gesture ends.
        deferredAdjustmentRef.current += adjustments;
        return;
      }
      // Our warm correction may precede its native scroll notification, so
      // virtual-core's offset can still describe the pre-chunk viewport.
      // Measurement adjustments are per-call deltas: apply them to the actual
      // viewport rather than reverting an already applied warm correction.
      const previous = element.scrollTop;
      const top = previous + adjustments;
      element.scrollTo?.(behavior === undefined ? { top } : { top, behavior });
      if (element.scrollTop !== previous) noteProgrammaticWrite("measurement");
    },
    // Finish compensation with the native gesture, not a later idle timer
    // which can replay it after focus has moved to another scroll owner.
    useScrollendEvent: true,
  });

  // Disclosure state commits before ResizeObserver's next delivery. Without
  // a synchronous measurement the old expanded height remains in the
  // virtualizer for a frame, leaving a blank band where later rows belong.
  // Capture the clicked row before React changes its body, then measure the
  // committed DOM in a layout effect so the corrected window paints at once.
  // measureElement without a ResizeObserverEntry returns the *cached* size,
  // so resizeItem must receive the row's actual post-commit offsetHeight.
  const measureDisclosureRow = (row: HTMLElement): void => {
    virtualizer.resizeItem(Number(row.dataset["index"]), row.offsetHeight);
  };
  const disclosureRowRef = useRef<{ row: HTMLElement; top: number } | null>(null);
  const [disclosureVersion, setDisclosureVersion] = useState(0);
  const onDisclosureClickCapture = (event: MouseEvent<HTMLDivElement>): void => {
    if (!(event.target instanceof Element) ||
      !event.target.closest(".th-tool-head, .th-chat-thinking-head")) return;
    holdDisclosurePosition();
    const row = event.target.closest<HTMLElement>(".th-chat-row[data-index]");
    if (row === null) return;
    disclosureRowRef.current = { row, top: row.getBoundingClientRect().top };
  };
  const onDisclosureClick = (): void => {
    if (disclosureRowRef.current === null) return;
    // React batches a real pointer click beyond Playwright's click return.
    // Flush after the child toggles, so the committed row and virtual window
    // both land before the browser can paint the old-sized empty band.
    flushSync(() => setDisclosureVersion((version) => version + 1));
  };
  useLayoutEffect(() => {
    const anchor = disclosureRowRef.current;
    if (anchor === null || !anchor.row.isConnected) return;
    measureDisclosureRow(anchor.row);
    const scroll = scrollRef.current;
    if (scroll !== null) {
      const previous = scroll.scrollTop;
      scroll.scrollTop += anchor.row.getBoundingClientRect().top - anchor.top;
      if (scroll.scrollTop !== previous) noteProgrammaticWrite("measurement");
    }
    disclosureRowRef.current = null;
  }, [disclosureVersion, virtualizer, scrollRef, noteProgrammaticWrite]);
  const onDisclosureTransitionEnd = (event: TransitionEvent<HTMLDivElement>): void => {
    if (event.propertyName !== "grid-template-rows" ||
      !(event.target instanceof Element) ||
      !event.target.matches(".th-chat-thinking-body")) return;
    const row = event.target.closest<HTMLElement>(".th-chat-row[data-index]");
    if (row !== null) measureDisclosureRow(row);
  };

  // virtual-core 3.17.6 corrects the scroll offset whenever a measured row
  // above the fold turns out taller or shorter than its estimate, so the
  // content the reader is looking at stays put. While a warm chunk settles,
  // everything above the anchor belongs to the effect below instead — one
  // owner for that block, so its growth is never compensated twice.
  // Supplying this hook replaces the library's own rule, so that rule is
  // restated here for every other row: a first measurement compensates when
  // the row's top is above the fold, a re-measurement only when the whole row
  // is and the reader is not scrolling backward.
  useLayoutEffect(() => {
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
      if (followMeasurementRef.current && isFollowing()) return true;
      const anchor = anchorRef.current;
      if (anchor !== null && item.index < anchor.index) return false;
      const element = scrollRef.current;
      if (element === null) return false;
      // The offset the reader will end up at: what the scrollport shows now
      // plus any compensation held back until the current gesture ends.
      const anchorStart = anchor === null ? undefined : instance.measurementsCache[anchor.index]?.start;
      const origin = historyRef.current?.offsetTop ?? 0;
      const warmAdjustment = anchor !== null && anchorStart !== undefined ? anchorStart + origin - anchor.start : 0;
      const fold = element.scrollTop + deferredAdjustmentRef.current + warmAdjustment - origin;
      if (!instance.itemSizeCache.has(item.key)) return item.start < fold;
      return item.start + item.size <= fold
        && (!instance.isScrolling || instance.scrollDirection !== "backward");
    };
  }, [virtualizer, scrollRef]);

  // A warm chunk lands ABOVE the reader, so every row already on screen moves
  // down by the height it inserts — first the chunk's estimated block, then
  // each row's measurement correction. Holding the scroll offset still would
  // throw the reader back by that entire height (63 chunks of a long session
  // move ~189,000px), so the offset moves WITH the block: the anchor row keeps
  // its place in the viewport and the reader's distance from the end of the
  // transcript does not change. Runs after every commit while armed; the
  // anchor's start only ever changes when the block above it does.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const element = scrollRef.current;
    if (anchor === null || element === null) return;
    const rowStart = virtualizer.measurementsCache[anchor.index]?.start;
    if (rowStart === undefined) return;
    // Loading/retry chrome above the history can disappear with this page.
    // Anchor in scroll-content coordinates, not only the virtual list's space.
    const start = rowStart + (historyRef.current?.offsetTop ?? 0);
    if (start === anchor.start) return;
    const previous = element.scrollTop;
    if (!virtualizer.elementsCache.get(anchor.key)?.isConnected) {
      // Re-enter the anchor's window before correcting its saved offset.
      // This is a one-shot reader restoration, never a new follow intent or
      // a numeric-index reconciliation that may outlive the next prepend.
      restoringAnchorRef.current = true;
      virtualizer.scrollToIndex(anchor.index, { align: "start" });
      restoringAnchorRef.current = false;
      virtualizer.scrollBy(0);
    }
    element.scrollTop = previous + start - anchor.start;
    // Ref measurements can advance before the DOM sizer's next commit. Only
    // retire the applied delta; browser clamping leaves the rest for that
    // commit even when the measurement itself no longer changes.
    anchorRef.current = { ...anchor, start: anchor.start + element.scrollTop - previous };
    if (element.scrollTop !== previous) {
      noteProgrammaticWrite("measurement");
      // The native scroll echo arrives after paint. Keep the rendered window
      // at the compensated viewport in this commit, not at the old offset.
      virtualizer.scrollOffset = element.scrollTop;
      setPinSyncVersion((version) => version + 1);
    }
  });

  useLayoutEffect(() => {
    const starts = new Map<string, number>();
    keys.forEach((key, index) => {
      const item = virtualizer.measurementsCache[index];
      if (item !== undefined) starts.set(key, item.start + (historyRef.current?.offsetTop ?? 0));
    });
    previousStartsRef.current = starts;
  });

  // The reader moving the viewport themselves retires the anchor: from here
  // their own position, not the pre-chunk one, is what later rows are held
  // against. Our own compensation write is not that signal.
  const onTranscriptScroll: typeof onScroll = (event) => {
    const wasFollowing = isFollowing();
    onScroll(event);
    if (wasFollowing && !isFollowing()) {
      // Retire the old numeric-index target through the public API. The
      // scrollToFn ownership check makes this a write-free cancellation;
      // otherwise a later jump could reauthorize that old reconciliation.
      // Unlike absolute commands, scrollBy replaces scrollState.index with
      // null without clearing virtual-core's deferred iOS measurement delta.
      virtualizer.scrollBy(0);
    }
    if (isReaderInputActive() || !isRecentProgrammaticWrite(event.currentTarget.scrollTop)) {
      anchorRef.current = null;
      retainedWindowRef.current = [];
      prependViewportRef.current = null;
    }
    // The sentinel can already sit inside the margin when follow intent ends
    // (short transcript): no crossing fires, so re-check after every scroll.
    if (sentinelInViewRef.current) maybeLoadOlder();
  };

  // Replay the compensation dropped during a scroll gesture once that
  // gesture ends. `scrollend` is the precise signal where supported;
  // elsewhere a debounce on `scroll` stands in (virtual-core's own
  // isScrollingResetDelay default is 150ms).
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const flush = (): void => {
      const pending = deferredAdjustmentRef.current;
      if (pending === 0) return;
      deferredAdjustmentRef.current = 0;
      const previous = element.scrollTop;
      element.scrollTop += pending;
      if (element.scrollTop !== previous) {
        noteProgrammaticWrite("measurement");
        virtualizer.scrollOffset = element.scrollTop;
        setPinSyncVersion((version) => version + 1);
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScrollDebounce = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(flush, 150);
    };
    const supportsScrollend = "onscrollend" in window;
    if (supportsScrollend) {
      // Watchdog: a gesture whose scrollend never arrives would otherwise
      // leave the compensation queued forever. Re-armed per scroll event, so
      // a genuinely ongoing gesture keeps deferring; once events stop, flush
      // anyway after a bounded wait.
      const armFallback = (): void => {
        if (deferredAdjustmentRef.current === 0) return;
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(flush, 400);
      };
      element.addEventListener("scrollend", flush);
      element.addEventListener("scroll", armFallback);
      return () => {
        element.removeEventListener("scrollend", flush);
        element.removeEventListener("scroll", armFallback);
        if (timer !== undefined) clearTimeout(timer);
      };
    }
    element.addEventListener("scroll", onScrollDebounce);
    return () => {
      element.removeEventListener("scroll", onScrollDebounce);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [scrollRef, noteProgrammaticWrite]);

  // The virtualizer learns DOM scroll writes only from the asynchronous
  // scroll observation: scrollToIndex writes the scroll position at once
  // (custom scrollToFn above), but the instance adopts the new offset when
  // the browser echoes the scroll event — after this commit has painted. The
  // window rendered by this commit would still describe the previous
  // viewport, so an open would paint one frame there before auto-scrolling
  // to the tail (the visible row count drops for a frame, then regrows).
  // Mirror the written position onto the instance — the same write
  // applyScrollAdjustment makes for measurement corrections — and bump state
  // so React re-renders this component before paint: the first paint of a
  // mounted/admitted history is already the tail window.
  const [, setPinSyncVersion] = useState(0);
  const pinTailBeforePaint = useCallback(() => {
    if (rows.length === 0) return;
    virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    const element = scrollRef.current;
    if (element === null) return;
    const offset = element.scrollTop;
    if (virtualizer.scrollOffset === offset) return;
    virtualizer.scrollOffset = offset;
    setPinSyncVersion((version) => version + 1);
  }, [rows.length, virtualizer, scrollRef]);

  // Focus GAIN / session-restore pin to the end regardless of follow intent.
  // Losing focus must NOT move the viewport: the reader keeps their parked
  // position. Scheduled before paint so a restored session never flashes the
  // pre-restore viewport.
  const prevRestoreVersionRef = useRef(restoreVersion);
  useLayoutEffect(() => {
    const restoreChanged = prevRestoreVersionRef.current !== restoreVersion;
    prevRestoreVersionRef.current = restoreVersion;
    if (!focused && !restoreChanged) return;
    pinTailBeforePaint();
    // pinTailBeforePaint and rows.length are read for the target index, not
    // as triggers: appending rows while focused must not yank a parked
    // reader — only focus gain and session restore pin regardless of intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, restoreVersion]);

  // Before paint: history admitted in this commit (the hydrating tail, an
  // on-demand older page, a live append while following) must surface at the
  // tail immediately — a pin scheduled after paint would let the reader see
  // one frame at the pre-admission offset.
  useLayoutEffect(() => {
    if (!isFollowing()) return;
    pinTailBeforePaint();
  }, [rows.length, isFollowing, pinTailBeforePaint]);

  useLayoutEffect(() => {
    if (!followMeasurementRef.current) return;
    followMeasurementRef.current = false;
    if (isFollowing() && !isReaderInputActive()) pinTailBeforePaint();
  });

  // Measurement-gated paint for batch admissions. A hydrating tail, an
  // on-demand older page, or a session restore first lays its rows out with
  // frozen estimates; real heights land a frame or two later and re-flow the
  // whole window (live QA on a 44 MB session: rendered/visible rows 19/10 ->
  // 12/4 right after open, and a 10 -> 6 dip on 3 of 39 prepended pages).
  // Hold the history layer visually hidden — visibility, NOT display, so the
  // absolute rows still mount and measure — for the commits it takes to apply
  // the tail pin / warm-anchor compensation on measured geometry, then reveal.
  // Measurement is synchronous in the row refs (offsetHeight -> itemSizeCache)
  // before any layout effect runs, so by the verification commit every mounted
  // row already reports its real height and the revealed frame IS the measured
  // layout. The reveal is a layout-effect setState: it commits before paint,
  // the first visible frame never shows estimated positions, and the commit
  // budget guarantees the layer is never held hidden (no tail-position
  // condition the pin could fail to satisfy). Live appends (leading key
  // unchanged) never arm the gate, so streaming content is never gated.
  const settleSnapshotRef = useRef<{
    readonly leading: string | undefined;
    readonly length: number;
    readonly restoreVersion: number;
  } | null>(null);
  const settleActiveRef = useRef(false);
  const settleRunsRef = useRef(0);
  const [, setSettleVersion] = useState(0);
  const settleSnapshot = settleSnapshotRef.current;
  // A batch admission arms the gate: the very first population, a population
  // after an empty mount, a session restore (any replacement carries a new
  // restoreVersion), or a prepend (the list grew and its leading key changed).
  // Identity comes from the same keys the virtualizer keys its rows by.
  const admissionArmed = keys.length > 0 && (
    settleSnapshot === null
    || settleSnapshot.restoreVersion !== restoreVersion
    || settleSnapshot.length === 0
    || (keys.length > settleSnapshot.length && keys[0] !== settleSnapshot.leading)
  );
  settleSnapshotRef.current = { leading: keys[0], length: keys.length, restoreVersion };
  if (admissionArmed) {
    settleActiveRef.current = true;
    settleRunsRef.current = 0;
  }
  const settling = settleActiveRef.current;
  const revealSettled = useCallback(() => {
    settleActiveRef.current = false;
    settleRunsRef.current = 0;
    measuringPrependRef.current = [];
    prependViewportRef.current = null;
    setSettleVersion((version) => version + 1);
  }, []);
  // A disconnected/clamped anchor may need another window/measurement frame.
  // Count frames, not React commits: several layout commits can precede one
  // paint. Cancel on every commit/unmount so no retired admission can reveal
  // a newer one. The watchdog also advances when no measurement notifies.
  useLayoutEffect(() => {
    const target = prependViewportRef.current;
    if (!settleActiveRef.current || target === null) return;
    const frame = requestAnimationFrame(() => {
      target.frames += 1;
      flushSync(() => setSettleVersion((version) => version + 1));
    });
    return () => cancelAnimationFrame(frame);
  });
  useLayoutEffect(() => {
    if (!settleActiveRef.current) return;
    settleRunsRef.current += 1;
    const target = prependViewportRef.current;
    if (target !== null && (target.frames >= 6 || performance.now() - target.started >= 100)) {
      revealSettled();
      return;
    }
    // rows emptied (chat cleared mid-settle): nothing to hide.
    if (rows.length === 0) {
      revealSettled();
      return;
    }
    const rendered = virtualizer.getVirtualItems();
    if (rendered.length === 0) {
      // No window yet: poll until it exists, but the budget always reveals.
      if (target !== null) return;
      if (settleRunsRef.current >= 4) revealSettled();
      else setSettleVersion((version) => version + 1);
      return;
    }
    // A user scroll can suppress the virtualizer's ref measurement. Explicitly
    // measure admitted rows here instead of revealing after a fixed number of
    // estimated commits. resizeItem schedules the measured sizer/positions.
    let measured = false;
    const measureKeys = target === null
      ? measuringPrependRef.current
      : rendered.map((item) => String(item.key));
    for (const key of measureKeys) {
      if (target === null && virtualizer.itemSizeCache.has(key)) continue;
      const row = virtualizer.elementsCache.get(key);
      const index = keys.indexOf(key);
      if (row instanceof HTMLElement && index >= 0) {
        const height = row.offsetHeight;
        // A row without a layout box cannot replace a ResizeObserver
        // measurement (for example while an ancestor pane is hidden).
        if (height > 0 && virtualizer.measurementsCache[index]?.size !== height) {
          virtualizer.resizeItem(index, height);
          measured = true;
        }
      }
    }
    if (measured) {
      setSettleVersion((version) => version + 1);
      return;
    }
    if (target !== null && !isFollowing()) {
      const scroll = scrollRef.current;
      const anchor = virtualizer.elementsCache.get(target.key);
      if (scroll === null) return;
      if (!anchor?.isConnected) {
        const index = keys.indexOf(target.key);
        if (index >= 0) {
          restoringAnchorRef.current = true;
          virtualizer.scrollToIndex(index, { align: "start" });
          restoringAnchorRef.current = false;
          virtualizer.scrollBy(0);
        }
      } else {
        const delta = anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top - target.top;
        if (Math.abs(delta) <= 1) {
          revealSettled();
          return;
        }
        const previous = scroll.scrollTop;
        scroll.scrollTop += delta;
        // This corrects the viewport, not the virtual row's measured start.
        // Feeding it into the warm baseline makes that effect undo this
        // correction on the next commit and starts a layout-update loop.
        if (scroll.scrollTop !== previous) noteProgrammaticWrite("measurement");
      }
      if (virtualizer.scrollOffset !== scroll.scrollTop) {
        virtualizer.scrollOffset = scroll.scrollTop;
        setSettleVersion((version) => version + 1);
      }
      return;
    }
    // Apply (or converge) the tail pin on the current geometry. The pin's own
    // scrollOffset mirror bumps state when it moves the window, which schedules
    // the next verification run before paint.
    if (isFollowing()) pinTailBeforePaint();
    // The armed commit pins and schedules a verification pass; the
    // verification commit — whose row refs have all measured by the time this
    // effect runs — reveals. The budget caps the hidden frames no matter what.
    if (settleRunsRef.current >= 2) revealSettled();
    else setSettleVersion((version) => version + 1);
  });

  return (
    <div className="th-chat-scrollport">
      <div className="th-chat-body" ref={scrollRef} tabIndex={0} onScroll={onTranscriptScroll}
        onClickCapture={onDisclosureClickCapture} onClick={onDisclosureClick}
        onTransitionEndCapture={onDisclosureTransitionEnd}>
        <div className="th-chat-content" ref={contentRef}>
          {historyFailedEmpty && (
            <div className="th-chat-history-failed" role="status">
              <span>{t("chat.historyFailedEmpty")}</span>
              <button type="button" className="th-btn th-btn--ghost th-chat-history-retry" onClick={onRetryHistory}>
                {t("common.retry")}
              </button>
            </div>
          )}
          {sentinelMounted && (
            <div ref={sentinelRef} className="th-chat-history-sentinel" data-state={olderState}>
              {olderState === "loading" && (
                <div className="th-chat-history-loading" role="status">
                  <span className="th-chat-history-spinner" aria-hidden="true" />
                  <span>{t("chat.loadingOlder")}</span>
                </div>
              )}
              {olderState === "error" && (
                <div className="th-chat-history-error" role="status">
                  <span>{t("chat.historyOlderFailed")}</span>
                  <button type="button" className="th-btn th-btn--ghost th-chat-history-retry" onClick={() => olderHistory?.loadOlder()}>
                    {t("common.retry")}
                  </button>
                </div>
              )}
            </div>
          )}
          {!historyLoaded && rows.length === 0 && !streaming && Object.keys(toolCalls).length === 0 && !error && !doneReason && (
            <div className="th-chat-loading" role="status">{t("chat.loading")}</div>
          )}
          <div
            ref={historyRef}
            className={`th-chat-history${settling ? " th-chat-history--settling" : ""}`}
            style={{ height: virtualizer.getTotalSize(), position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const item = rows[virtualItem.index];
              if (!item) return null;
              if (item.kind === "notice") {
                return (
                  <div
                    key={virtualItem.key}
                    data-index={virtualItem.index}
                    data-entry-key={virtualItem.key}
                    ref={virtualizer.measureElement}
                    className="th-chat-row th-chat-row--notice"
                    style={{ position: "absolute", top: 0, transform: `translateY(${virtualItem.start}px)` }}
                  >
                    <TranscriptNoticeRow notice={item.notice} />
                  </div>
                );
              }
              const message = item.message;
              const previousItem = rows[virtualItem.index - 1];
              const continuesFromPrevious =
                previousItem !== undefined && previousItem.kind === "message"
                  ? RECORD_BLOCK_KINDS.has(lastRowBlock(previousItem.message)?.kind ?? "")
                  : false;
              return (
                <div
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  data-entry-key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  className={`th-chat-row th-chat-row--${message.role}${userTurnStart(rows, virtualItem.index) ? " th-chat-row--turn-start" : ""}`}
                  style={{ position: "absolute", top: 0, transform: `translateY(${virtualItem.start}px)` }}
                >
                  <div
                    className={`th-chat-msg th-chat-msg--${message.role}${enterClassFor(String(virtualItem.key))}`}
                    role={message.role === "user" ? "group" : undefined}
                    aria-label={message.role === "user" ? t("chat.fromUser") : undefined}
                  >
                    {message.customType === "steer" ? (
                      <div className="th-chat-msg th-chat-msg--steer" role="note">
                        <span className="th-chat-steer-mark">{t("chat.steer")}</span>
                        <span className="th-chat-steer-text">{rowText(message)}</span>
                      </div>
                    ) : message.summaryKind !== undefined ? (
                      // Hydrated summary entries render as summary boxes in
                      // the notice-box visual language, never as hook cards.
                      // Routing keys on the persisted-entry provenance tag
                      // (summaryKind) alone: an ordinary custom message whose
                      // customType happens to be named "compaction" or
                      // "branch_summary" stays on the HookCard path below.
                      <SummaryNoticeBox
                        label={message.summaryKind === "compaction" ? "[compaction]" : "[branch]"}
                        summary={rowText(message)}
                        {...(message.summaryKind === "compaction" && typeof message.tokensBefore === "number"
                          ? { tokensBefore: message.tokensBefore }
                          : {})}
                        // The parser always stamps summaryKind messages
                        // (entry timestamp, else the frozen hydration
                        // receipt time); the ?? 0 only satisfies the type.
                        at={message.ts ?? 0}
                      />
                    ) : message.role === "custom" ? (
                      <HookCard hookType={message.customType ?? "hook"} text={rowText(message)} />
                    ) : (
                      <>
                        {renderMessageBlocks(message, String(virtualItem.key), continuesFromPrevious)}
                        {isFailedTurn(message) && failedTurnText(message) !== null && (
                          // Wire-only wording: the failure text exactly as it
                          // arrived; when the turn carries no text, the
                          // wire-provided stopReason value itself, so a failed
                          // turn is never silent and nothing is fabricated.
                          <div className="th-chat-error th-chat-turn-error" role="alert">
                            {failedTurnText(message)}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="th-chat-live" aria-live="polite">
            {thinking && (
              <ThinkingDisclosure
                text={thinking}
                running
                className={enterClassFor("live:thinking")}
              />
            )}
            {Object.entries(toolCalls)
              .filter(([id]) => !historyToolIds.has(id))
              .map(([id, entry], toolIndex) => {
                // Live result media rides inside the invocation's disclosure
                // like the finalized card's: it renders while the card is
                // collapsed too, and an image_ref fetches only when its
                // element enters the viewport. The one-shot entrance class
                // lands on the card root (or the existing media wrapper),
                // never in a conditional wrapper: a structural flip here
                // would remount the card and orphan held head references.
                const media = entry.media ?? [];
                const liveEnterClass = enterClassFor(`live:tool:${id}`);
                if (media.length === 0) {
                  return rememberedToolCard({
                    toolCallId: id,
                    toolName: entry.toolName,
                    phase: entry.phase,
                    text: entry.text,
                    isError: entry.isError,
                    details: entry.details,
                    args: entry.args,
                    // The live timeline runs thinking, then calls in order:
                    // a call continues the rail when thinking is above it or
                    // an earlier live call precedes it.
                    continuesRail: thinking !== "" || toolIndex > 0,
                    className: liveEnterClass,
                  });
                }
                return (
                  <div key={id} className={`th-chat-tool-media${liveEnterClass}`}>
                    {rememberedToolCard({
                      toolCallId: id,
                      toolName: entry.toolName,
                      phase: entry.phase,
                      text: entry.text,
                      isError: entry.isError,
                      details: entry.details,
                      args: entry.args,
                      continuesRail: thinking !== "" || toolIndex > 0,
                    })}
                    {media.map((image, mediaIndex) => renderMedia(image, `live:${id}:${mediaIndex}`, `media:${id}:${mediaIndex}`))}
                  </div>
                );
              })}
            {streaming && (
              <div className={`th-chat-msg th-chat-msg--streaming${enterClassFor("live:streaming")}`}>
                <div className="th-chat-markdown">
                  <Markdown text={streaming} />
                </div>
              </div>
            )}
            {doneReason && (
              <div className={`${isStopError(doneReason) ? "th-chat-error" : "th-chat-done"}${enterClassFor("live:done")}`}>
                {t(isStopError(doneReason) ? "chat.stoppedError" : "chat.done")}
              </div>
            )}
            {error && <div className={`th-chat-error${enterClassFor("live:error")}`} role="alert">{error}</div>}
          </div>
        </div>
      </div>
      {showScrollToBottom && (
        <button type="button" className="th-chat-scroll-bottom" aria-label={t("chat.scrollToBottom")} onClick={() => scrollToBottom()}>
          ↓
        </button>
      )}
      <ModalDialog
        open={zoomedSrc !== null}
        onClose={closeZoom}
        variant="media"
        closeLabel={t("common.close")}
        labelledBy={imageZoomTitleId}
      >
        <h2 id={imageZoomTitleId} className="th-visually-hidden">{t("chat.imageZoomTitle")}</h2>
        {zoomedSrc !== null && (
          <img className="th-modal-media-image" src={zoomedSrc} alt={t("chat.image")} />
        )}
      </ModalDialog>
    </div>
  );
}
