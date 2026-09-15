import { FONT_SIZE_DEFAULT } from "../../lib/font";
import type { ChatNotice, TranscriptItem } from "./useChatFrameState";

export interface RowMetrics {
  readonly laneWidth: number;
  readonly bodyLineHeight: number;
  readonly secondaryLineHeight: number;
  readonly charWidth: number;
  readonly monoCharWidth: number;
}

// .th-chat-row padding 8px top and bottom
const ROW_PAD_TOP = 8;
const ROW_PAD_BOTTOM = 8;
// .th-chat-row--turn-start adds 20px padding-top
const TURN_START_PAD_TOP = 20;
// .th-chat-msg max-width: 80% (assistant overrides this to 100%)
const USER_MSG_MAX_WIDTH_RATIO = 0.8;
// .th-chat-msg padding: var(--th-space-2) var(--th-space-3) → 8px vertical, 12px horizontal
const MSG_PAD_Y = 8;
const MSG_PAD_X = 12;
// .th-chat-msg--user border: 1px solid → 1px top + 1px bottom
const USER_MSG_BORDER_Y = 1 + 1;
// .th-chat-markdown p margin-bottom 12px
const PARAGRAPH_GAP = 12;
// .th-chat-markdown pre padding 8px/12px plus a 1px border
const CODE_FENCE_CHROME = 8 + 8 + 1 + 1;
// .th-chat-image has max-height 320px plus 8px margin-block-start
const IMAGE_BLOCK_HEIGHT = 320 + 8;

// Lowercase-dominant English with spaces and punctuation, matching the prose
// the transcript wraps. An A-Z/0-9 mix over-weights wide capitals and digits.
const SAMPLE =
  "The transcript keeps a complete record of the discussion. Each message has a stable identity, and the browser measures its rendered height as it enters the visible region. This example includes enough detail to wrap naturally on a narrow mobile screen.";

// Fallback ratios from tokens.css when jsdom (or a hidden node) yields 0 layout.
const BODY_LINE_RATIO = 1.6;
const SECONDARY_SIZE_RATIO = 0.9286;
const SECONDARY_LINE_RATIO = 1.45;
const MONO_ADVANCE_RATIO = 0.6;
const FALLBACK_LANE_WIDTH = 390;

interface MetricsCache {
  readonly lane: number;
  readonly font: number;
  readonly family: string;
  readonly metrics: RowMetrics;
}

let cache: MetricsCache | undefined;

function sizeToGlyphAdvance(el: HTMLElement): void {
  el.style.display = "inline-block";
  el.style.width = "max-content";
  el.style.maxWidth = "none";
  el.style.whiteSpace = "pre";
}

function fallbackMetrics(): RowMetrics {
  const fontSize = FONT_SIZE_DEFAULT;
  return {
    laneWidth: FALLBACK_LANE_WIDTH,
    bodyLineHeight: fontSize * BODY_LINE_RATIO,
    secondaryLineHeight: fontSize * SECONDARY_SIZE_RATIO * SECONDARY_LINE_RATIO,
    charWidth: fontSize * MONO_ADVANCE_RATIO,
    monoCharWidth: fontSize * MONO_ADVANCE_RATIO,
  };
}

function parsePx(raw: string): number {
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function lineHeightPx(style: CSSStyleDeclaration, fontSize: number, fallback: number): number {
  const raw = style.lineHeight;
  if (raw === "normal" || raw === "") {
    return fontSize > 0 ? fontSize * BODY_LINE_RATIO : fallback;
  }
  if (raw.endsWith("%")) {
    const percent = Number.parseFloat(raw);
    return percent > 0 && fontSize > 0 ? (percent / 100) * fontSize : fallback;
  }
  if (raw.endsWith("px")) {
    const px = Number.parseFloat(raw);
    return px > 0 ? px : fallback;
  }
  const unitless = Number.parseFloat(raw);
  if (!Number.isFinite(unitless) || unitless <= 0) return fallback;
  return fontSize > 0 ? unitless * fontSize : fallback;
}

function metricsFamilyKey(scrollElement: HTMLElement): string {
  const computed = getComputedStyle(scrollElement).fontFamily;
  const applied = document.documentElement.style.getPropertyValue("--th-font-mono").trim();
  return applied.length > 0 ? `${computed}\n${applied}` : computed;
}

/**
 * Live lane / type metrics for the transcript virtualizer. Appends an offscreen
 * probe with the real row classes, then removes it. Cached by rounded lane
 * width, resolved font-size, and font family (computed plus the applied
 * --th-font-mono stack); falls back when layout is missing (jsdom).
 */
export function readRowMetrics(scrollElement: HTMLElement | null): RowMetrics {
  const fallback = fallbackMetrics();
  if (scrollElement === null) return fallback;

  const fontHint = parsePx(getComputedStyle(scrollElement).fontSize);
  const familyHint = metricsFamilyKey(scrollElement);
  const laneHint = scrollElement.clientWidth;
  const keyLane = Math.round(laneHint);
  const keyFont = Math.round(fontHint);
  if (
    cache !== undefined
    && cache.lane === keyLane
    && cache.font === keyFont
    && cache.family === familyHint
    && keyLane > 0
    && keyFont > 0
  ) {
    return cache.metrics;
  }

  const probe = document.createElement("div");
  probe.className = "th-chat-row th-chat-row--assistant";
  probe.setAttribute("aria-hidden", "true");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.top = "0";
  // Inherit .th-chat-row { width: min(var(--th-chat-max), calc(100% + 2*var(--th-chat-scrollbar) - 2*var(--th-chat-gutter))) }
  // and .th-chat-msg / .th-chat-msg--assistant box rules. Do not force left/right/width.

  const msg = document.createElement("div");
  msg.className = "th-chat-msg th-chat-msg--assistant";

  const markdown = document.createElement("div");
  markdown.className = "th-chat-markdown";

  const bodySpan = document.createElement("span");
  bodySpan.textContent = SAMPLE;
  sizeToGlyphAdvance(bodySpan);

  const pre = document.createElement("pre");
  const code = document.createElement("code");
  const monoSpan = document.createElement("span");
  monoSpan.textContent = SAMPLE;
  sizeToGlyphAdvance(monoSpan);
  code.append(monoSpan);
  pre.append(code);

  markdown.append(bodySpan, pre);
  msg.append(markdown);
  probe.append(msg);
  scrollElement.append(probe);

  try {
    const laneWidth = probe.getBoundingClientRect().width;
    const bodyStyle = getComputedStyle(msg);
    const codeStyle = getComputedStyle(code);
    const fontSize = parsePx(bodyStyle.fontSize);
    if (laneWidth <= 0 || fontSize <= 0) return fallback;

    const charWidth = bodySpan.getBoundingClientRect().width / SAMPLE.length;
    const monoCharWidth = monoSpan.getBoundingClientRect().width / SAMPLE.length;
    if (charWidth <= 0) return fallback;

    const codeFontSize = parsePx(codeStyle.fontSize) || fontSize;
    const metrics: RowMetrics = {
      laneWidth,
      bodyLineHeight: lineHeightPx(bodyStyle, fontSize, fallback.bodyLineHeight),
      secondaryLineHeight: lineHeightPx(codeStyle, codeFontSize, fallback.secondaryLineHeight),
      charWidth,
      monoCharWidth: monoCharWidth > 0 ? monoCharWidth : fallback.monoCharWidth,
    };
    if (keyLane > 0 && keyFont > 0) {
      cache = { lane: keyLane, font: keyFont, family: familyHint, metrics };
    }
    return metrics;
  } finally {
    probe.remove();
  }
}

function wrapLines(
  text: string,
  lineHeight: number,
  charWidth: number,
  laneWidth: number,
  blankLineHeight: number,
): number {
  const charsPerLine = Math.max(1, Math.floor(laneWidth / charWidth));
  let height = 0;
  for (const line of text.split("\n")) {
    if (line.length === 0) {
      height += blankLineHeight;
      continue;
    }
    height += Math.max(1, Math.ceil(line.length / charsPerLine)) * lineHeight;
  }
  return height;
}

function estimateMarkdownHeight(text: string, metrics: RowMetrics, wrapWidth: number): number {
  if (text.length === 0) return metrics.bodyLineHeight;
  const lines = text.split("\n");
  let height = 0;
  let inCode = false;
  let fenceBlocks = 0;
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      if (!inCode) fenceBlocks += 1;
      inCode = !inCode;
      height += metrics.bodyLineHeight;
      continue;
    }
    if (inCode) {
      height += line.length === 0
        ? metrics.secondaryLineHeight
        : wrapLines(line, metrics.secondaryLineHeight, metrics.monoCharWidth, wrapWidth, metrics.secondaryLineHeight);
      continue;
    }
    if (line.length === 0) {
      height += PARAGRAPH_GAP;
      continue;
    }
    height += wrapLines(line, metrics.bodyLineHeight, metrics.charWidth, wrapWidth, PARAGRAPH_GAP);
  }
  return height + fenceBlocks * CODE_FENCE_CHROME;
}

function payloadString(payload: ChatNotice["payload"], key: string): string {
  if (payload === null) return "";
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function estimateNoticeHeight(notice: ChatNotice, metrics: RowMetrics): number {
  const text =
    payloadString(notice.payload, "message") ||
    payloadString(notice.payload, "text") ||
    payloadString(notice.payload, "title") ||
    notice.kind;
  return estimateMarkdownHeight(text, metrics, metrics.laneWidth);
}

function userBubbleWrapWidth(laneWidth: number): number {
  return Math.max(1, laneWidth * USER_MSG_MAX_WIDTH_RATIO - MSG_PAD_X * 2);
}

export function estimateRowHeight(item: TranscriptItem, metrics: RowMetrics): number {
  const isUser = item.kind === "message" && item.message.role === "user";
  let height = ROW_PAD_TOP + ROW_PAD_BOTTOM;
  const wrapWidth = isUser ? userBubbleWrapWidth(metrics.laneWidth) : metrics.laneWidth;
  if (isUser) {
    height += TURN_START_PAD_TOP - ROW_PAD_TOP;
    height += MSG_PAD_Y + MSG_PAD_Y;
    height += USER_MSG_BORDER_Y;
  }

  if (item.kind === "notice") {
    return Math.ceil(height + estimateNoticeHeight(item.notice, metrics));
  }

  const blocks = item.message.blocks ?? [];
  if (blocks.length === 0) {
    return Math.ceil(height + metrics.bodyLineHeight);
  }

  for (const block of blocks) {
    if (block.kind === "image" || block.kind === "image_ref") {
      height += IMAGE_BLOCK_HEIGHT;
      continue;
    }
    if (block.kind === "tool" || block.kind === "toolCall" || block.kind === "toolResult") {
      // A collapsed tool card is a single-line row.
      height += metrics.bodyLineHeight;
      continue;
    }
    if (block.kind === "thinking") {
      height += metrics.bodyLineHeight;
      continue;
    }
    height += estimateMarkdownHeight(block.text ?? "", metrics, wrapWidth);
  }

  return Math.ceil(height);
}
