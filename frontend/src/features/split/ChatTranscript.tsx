import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import "../../styles/math.css";
import { useT } from "../../i18n";
import type { Paragraph, Root } from "mdast";
import type {} from "mdast-util-math";
import type { UiMessage } from "./chatEntries";
import type { ToolEntry } from "./chatSessionTypes";
import { HookCard } from "./HookCard";
import { remarkBackslashMath } from "./mathDelimiters";
import { ToolCard, type ToolCardProps } from "./ToolCard";
import { TranscriptNoticeRow } from "./TranscriptNoticeRow";
import { useChatScroll } from "./useChatScroll";
import type { TranscriptItem } from "./useChatFrameState";

function blockKey(block: NonNullable<UiMessage["blocks"]>[number]): string {
  return block.id ?? `${block.kind}:${block.name ?? ""}:${block.text ?? block.thinking ?? ""}:${JSON.stringify(block.arguments ?? null)}`;
}

function messageText(message: UiMessage): string {
  return (message.blocks ?? [])
    .map((block) => block.text ?? block.thinking ?? "")
    .filter((text) => text.length > 0)
    .join("\n");
}

const STOP_ERROR_REASONS = new Set(["max_tokens", "length", "content_filter", "refusal", "error"]);

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

interface ChatTranscriptProps {
  /** Unified render list: conversation entries merged with notice blocks. */
  readonly items: readonly TranscriptItem[];
  readonly streaming: string;
  readonly thinking: string;
  readonly toolCalls: Readonly<Record<string, ToolEntry>>;
  readonly doneReason: string | null;
  readonly error: string;
  readonly restoreVersion: number;
  readonly focused: boolean;
  readonly historyLoaded: boolean;
  /** View-local notice hide; never mutates the notice list nor the server. */
  readonly onDismissNotice: (id: number) => void;
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
  onDismissNotice,
}: ChatTranscriptProps) {
  const { t } = useT();
  const { scrollRef, contentRef, showScrollToBottom, onScroll, scrollToBottom } = useChatScroll(restoreVersion, focused);
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

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 80,
    overscan: 4,
  });

  useEffect(() => {
    if (focused && items.length > 0) {
      virtualizer.scrollToIndex(items.length - 1, { align: "end" });
    }
  }, [focused, restoreVersion, items.length, virtualizer]);

  return (
    <div className="th-chat-scrollport">
      <div className="th-chat-body" ref={scrollRef} onScroll={onScroll}>
        <div className="th-chat-content" ref={contentRef}>
          {!historyLoaded && items.length === 0 && !streaming && Object.keys(toolCalls).length === 0 && !error && !doneReason && (
            <div className="th-chat-loading" role="status">{t("chat.loading")}</div>
          )}
          <div className="th-chat-history" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const item = items[virtualItem.index];
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
                    <TranscriptNoticeRow notice={item.notice} onDismiss={onDismissNotice} />
                  </div>
                );
              }
              const message = item.message;
              return (
                <div
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  className={`th-chat-row th-chat-row--${message.role}`}
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
                    ) : message.role === "custom" ? (
                      <HookCard hookType={message.customType ?? "hook"} text={messageText(message)} />
                    ) : (message.blocks ?? []).map((block) => {
                      if (block.kind === "thinking") {
                        return (
                          <details key={blockKey(block)} className="th-chat-thinking">
                            <summary>{t("chat.thinking")}</summary>
                            <pre>{block.thinking ?? block.text}</pre>
                          </details>
                        );
                      }
                      if (block.kind === "tool" || block.kind === "toolCall" || block.kind === "toolResult") {
                        // A live result streaming for this disclosure's call id
                        // finalizes it in place: show the live phase/output so
                        // the invocation renders one card, not a detached twin.
                        const live = block.id ? toolCalls[block.id] : undefined;
                        return rememberedToolCard({
                          toolCallId: block.id ?? blockKey(block),
                          toolName: block.name ?? live?.toolName ?? "",
                          phase: live?.phase ?? "end",
                          text: live ? live.text : block.text ?? "",
                          isError: live?.isError ?? block.isError ?? false,
                          details: live?.details,
                          args: live?.args ?? block.arguments,
                        });
                      }
                      return message.role === "assistant" ? (
                        <div key={blockKey(block)} className="th-chat-markdown">
                          <Markdown text={block.text ?? ""} />
                        </div>
                      ) : (
                        <span key={blockKey(block)}>{block.text}</span>
                      );
                    })}
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
              .map(([id, entry]) => rememberedToolCard({
                toolCallId: id,
                toolName: entry.toolName,
                phase: entry.phase,
                text: entry.text,
                isError: entry.isError,
                details: entry.details,
                args: entry.args,
              }))}
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
    </div>
  );
}
