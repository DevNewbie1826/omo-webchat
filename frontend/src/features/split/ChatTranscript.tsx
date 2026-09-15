import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
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
} from "../../lib/chatMedia";;
import type { Paragraph, Root } from "mdast";
import type {} from "mdast-util-math";
import type { UiMessage } from "./chatEntries";
import { hasRenderableContent, isFailedTurn } from "./chatEntries";
import type { ToolEntry, ToolResultImage } from "./chatSessionTypes";
import { HookCard } from "./HookCard";
import { remarkBackslashMath } from "./mathDelimiters";
import { ToolCard, type ToolCardProps } from "./ToolCard";
import { TranscriptNoticeRow } from "./TranscriptNoticeRow";
import { SummaryNoticeBox } from "./SummaryNoticeBox";
import { useChatScroll } from "./useChatScroll";
import { ModalDialog } from "../../components/ModalDialog";
import { estimateRowHeight, readRowMetrics } from "./chatRowEstimate";
import type { TranscriptItem } from "./useChatFrameState";

function blockKey(block: NonNullable<UiMessage["blocks"]>[number]): string {
  return block.id ?? `${block.kind}:${block.name ?? ""}:${block.text ?? block.thinking ?? ""}:${JSON.stringify(block.arguments ?? null)}`;
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

function messageText(message: UiMessage): string {
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

export function transcriptItemKeys(items: readonly TranscriptItem[]): readonly string[] {
  let messageOrdinal = 0;
  return items.map((item) => {
    if (item.kind === "notice") return `notice:${item.notice.id}`;
    const message = item.message;
    const fallback = messageOrdinal++;
    if (message.id !== undefined) return `message:${message.id}`;
    // Notice insertion/dismissal does not change the authoritative message
    // ordinal, so even legacy id-less messages retain their virtual row.
    return `message-ordinal:${fallback}`;
  });
}

const MISSING_ROW: TranscriptItem = {
  kind: "message",
  message: { role: "assistant", blocks: [] },
};

/** Inline image carried on a preserved block: bytes already inline as base64. */
/** Stable logical identity of a zoomed image's trigger, threaded onto the
 * button as data-zoom-key so a close-time re-resolution never has to match
 * on the raw <img> src (ambiguous when two images share bytes). Referenced
 * images resolve by their media coordinate; inline images by the block/media
 * key already used as the React key. */
type ZoomOpen = (src: string, trigger: HTMLElement) => void;

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
}

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
  const { scrollRef, contentRef, showScrollToBottom, onScroll, scrollToBottom, isFollowing } = useChatScroll(restoreVersion, focused, clearDeferredAdjustment);
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
  const renderMessageBlocks = (message: UiMessage, rowKey: string): ReactNode[] => {
    const blocks = message.blocks ?? [];
    const groupedResultImages = new Set<number>();
    return blocks.map((block, blockIndex) => {
      if ((block.kind === "image" || block.kind === "image_ref") && groupedResultImages.has(blockIndex)) return null;
      if (block.kind === "thinking") {
        return (
          <details key={blockKey(block)} className="th-chat-thinking">
            <summary>{t("chat.thinking")}</summary>
            <pre>{block.thinking ?? block.text}</pre>
          </details>
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

  // Row identity is assigned over the FULL merged list before any hiding:
  // an empty assistant completion (invisible but state-retained as a
  // current-turn tool anchor) permanently occupies its message ordinal, so
  // it materializing a tool row — or appearing or disappearing — never
  // shifts any other row's key and no visible row remounts. Only after
  // identity assignment are zero-renderable-block rows hidden from the
  // virtualized window.
  const { rows, keys } = useMemo(() => {
    const allKeys = transcriptItemKeys(items);
    const rows: TranscriptItem[] = [];
    const keys: string[] = [];
    items.forEach((item, index) => {
      const key = allKeys[index] ?? `missing:${index}`;
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
    return { rows, keys };
  }, [items, rowMetrics, estimateCache]);
  // Include rowMetrics so a typography/width update rebuilds measurements
  // in the same render that installs the new estimates. Content-only
  // updates still hit the frozen per-key estimate cache; measured sizes
  // in the virtualizer's itemSizeCache continue to win.
  const getItemKey = useCallback(
    (index: number) => keys[index] ?? `missing:${index}`,
    [keys, rowMetrics],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getItemKey,
    getScrollElement: () => scrollRef.current,
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
    // virtual-core passes `adjustments` ONLY for measurement-driven
    // corrections; every explicit scrollToIndex/scrollToOffset passes
    // undefined. Drop those corrections while a user scroll is in flight:
    // any programmatic scroll write cancels the browser's in-flight scroll
    // animation, so a mid-gesture correction would kill the fling dead.
    scrollToFn: (offset, { adjustments, behavior }, instance) => {
      const element = instance.scrollElement;
      if (element === null) return;
      if (adjustments === undefined) {
        // Genuine scroll intent (scrollToIndex/scrollToOffset): the viewport
        // is being moved deliberately, so any deferred compensation is moot.
        deferredAdjustmentRef.current = 0;
        element.scrollTo?.(behavior === undefined ? { top: offset } : { top: offset, behavior });
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
      const top = offset + adjustments;
      element.scrollTo?.(behavior === undefined ? { top } : { top, behavior });
    },
    // Finish compensation with the native gesture, not a later idle timer
    // which can replay it after focus has moved to another scroll owner.
    useScrollendEvent: true,
  });

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
      element.scrollTop += pending;
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
  }, [scrollRef]);

  // Focus GAIN / session-restore pin to the end regardless of follow intent.
  // Losing focus must NOT move the viewport: the reader keeps their parked
  // position. Row-count growth only follows when already at the bottom.
  const prevRestoreVersionRef = useRef(restoreVersion);
  useEffect(() => {
    const restoreChanged = prevRestoreVersionRef.current !== restoreVersion;
    prevRestoreVersionRef.current = restoreVersion;
    if (rows.length === 0) return;
    if (!focused && !restoreChanged) return;
    virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    // rows.length is read for the target index, not as a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, restoreVersion, virtualizer]);

  useEffect(() => {
    if (rows.length === 0 || !isFollowing()) return;
    virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
  }, [rows.length, isFollowing, virtualizer]);

  return (
    <div className="th-chat-scrollport">
      <div className="th-chat-body" ref={scrollRef} onScroll={onScroll}>
        <div className="th-chat-content" ref={contentRef}>
          {!historyLoaded && rows.length === 0 && !streaming && Object.keys(toolCalls).length === 0 && !error && !doneReason && (
            <div className="th-chat-loading" role="status">{t("chat.loading")}</div>
          )}
          <div className="th-chat-history" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const item = rows[virtualItem.index];
              if (!item) return null;
              if (item.kind === "notice") {
                return (
                  <div
                    key={virtualItem.key}
                    data-index={virtualItem.index}
                    ref={virtualizer.measureElement}
                    className="th-chat-row th-chat-row--notice"
                    style={{ position: "absolute", top: 0, transform: `translateY(${virtualItem.start}px)` }}
                  >
                    <TranscriptNoticeRow notice={item.notice} />
                  </div>
                );
              }
              const message = item.message;
              return (
                <div
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  className={`th-chat-row th-chat-row--${message.role}${userTurnStart(rows, virtualItem.index) ? " th-chat-row--turn-start" : ""}`}
                  style={{ position: "absolute", top: 0, transform: `translateY(${virtualItem.start}px)` }}
                >
                  <div
                    className={`th-chat-msg th-chat-msg--${message.role}`}
                    role={message.role === "user" ? "group" : undefined}
                    aria-label={message.role === "user" ? t("chat.fromUser") : undefined}
                  >
                    {message.customType === "steer" ? (
                      <div className="th-chat-msg th-chat-msg--steer" role="note">
                        <span className="th-chat-steer-mark">{t("chat.steer")}</span>
                        <span className="th-chat-steer-text">{messageText(message)}</span>
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
                        summary={messageText(message)}
                        {...(message.summaryKind === "compaction" && typeof message.tokensBefore === "number"
                          ? { tokensBefore: message.tokensBefore }
                          : {})}
                        // The parser always stamps summaryKind messages
                        // (entry timestamp, else the frozen hydration
                        // receipt time); the ?? 0 only satisfies the type.
                        at={message.ts ?? 0}
                      />
                    ) : message.role === "custom" ? (
                      <HookCard hookType={message.customType ?? "hook"} text={messageText(message)} />
                    ) : (
                      <>
                        {renderMessageBlocks(message, String(virtualItem.key))}
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
              <details className="th-chat-thinking">
                <summary>{t("chat.thinking")}</summary>
                <pre>{thinking}</pre>
              </details>
            )}
            {Object.entries(toolCalls)
              .filter(([id]) => !historyToolIds.has(id))
              .map(([id, entry]) => {
                const card = rememberedToolCard({
                  toolCallId: id,
                  toolName: entry.toolName,
                  phase: entry.phase,
                  text: entry.text,
                  isError: entry.isError,
                  details: entry.details,
                  args: entry.args,
                });
                // Live result media rides inside the invocation's disclosure
                // like the finalized card's: it renders while the card is
                // collapsed too, and an image_ref fetches only when its
                // element enters the viewport.
                const media = entry.media ?? [];
                if (media.length === 0) return card;
                return (
                  <div key={id} className="th-chat-tool-media">
                    {card}
                    {media.map((image, mediaIndex) => renderMedia(image, `live:${id}:${mediaIndex}`, `media:${id}:${mediaIndex}`))}
                  </div>
                );
              })}
            {streaming && (
              <div className="th-chat-msg th-chat-msg--streaming">
                <div className="th-chat-markdown">
                  <Markdown text={streaming} />
                </div>
              </div>
            )}
            {doneReason && (
              <div className={isStopError(doneReason) ? "th-chat-error" : "th-chat-done"}>
                {t(isStopError(doneReason) ? "chat.stoppedError" : "chat.done")}
              </div>
            )}
            {error && <div className="th-chat-error" role="alert">{error}</div>}
          </div>
        </div>
      </div>
      {showScrollToBottom && (
        <button type="button" className="th-chat-scroll-bottom" aria-label={t("chat.scrollToBottom")} onClick={scrollToBottom}>
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
