import { useLayoutEffect, useRef, useState } from "react";
import { useT, type Translate } from "../../i18n";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { statusKind, statusLabel, type DagView } from "./activityShelfModel";
import { ActivityChip } from "./activityShelfSections";
import { dagNodeTitle } from "./dagNodeTitle";
import type { ActivityDagNode, ActivityDagRun } from "./activityTypes";

/*
 * Living-graph geometry (v2). Every value is at the default Label tier (13px
 * base) and the card scales with the measured Label and Micro fonts.
 * Width, row pitch and glyph lane grow with the text, without a density cap.
 * Each node owns
 * one cell of the wave/layer grid, so dense runs (64 nodes) never overlap:
 * GAP_Y keeps stacked cards clear of a running neighbour's halo (HALO_SPREAD
 * plus the blur's visible falloff), GAP_X leaves room for the bezier
 * curvature and the arrowhead, and PADDING keeps an edge node's halo inside
 * the SVG viewport. The pitch (NODE_WIDTH + GAP_X = 136) is sized so the
 * mixed stage shows at least five whole cards inside the 736px reading-column
 * reel at 1280 on first paint (E9; the painted width scales with the measured
 * Label font — 120px at the default 13px setting — so the constant keeps five
 * cards whole at the default type setting), and the compact PADDING/GAP_Y keep
 * more of the run visible before the panel scrolls (E11). The
 * card's radius/padding/gap are NOT constants: they resolve from the --th-*
 * radius/spacing tokens below, so a token change moves the painted card, the
 * glyph lane and the label clips together.
 */
const NODE_WIDTH = 120;
const GAP_X = 16;
const GAP_Y = 12;
const PADDING = 10;
/* Phones keep desktop's left-to-right wave columns. Only card dimensions
 * and gaps shrink; the reel owns horizontal overflow. */
const COMPACT_BREAKPOINT = 640;
const COMPACT_MIN_CARD = 104;
const COMPACT_GAP_X = 8;
const COMPACT_GAP_Y = 4;
const COMPACT_PADDING = 8;
const COMPACT_PAD_X = 6;
const COMPACT_PAD_Y = 6;
const COMPACT_GLYPH_GAP = 2;
const COMPACT_RADIUS = 8;
const COMPACT_ROW_LINE = 1;
const COMPACT_STATE_LINE = 1;
const HALO_SPREAD = 2;
const HALO_BLUR = 3;
const COMET_BLUR = 1.5;
const LABEL_TIER = 0.8571;
const MICRO_TIER = 0.7857;
const MIN_GRAPH_TYPE_PX = 11;
/** The measured title font determines card size, row pitch and glyph lane. */
const DEFAULT_TYPE_PX = 13 * LABEL_TIER;

/** Card radius/padding/gap, resolved from the token contract. The 10px
 *  padX and 6px glyph gap sit between single spacing steps, so they compose
 *  two steps (space-2 + space-0-5, space-1 + space-0-5) and every input
 *  stays a --th-* token. Each metric falls back independently to the token
 *  default so a renderer without a resolved stylesheet (tests, SSR) still
 *  paints, and a partially overridden token still moves its own metric. */
interface CardSpacing {
  readonly radius: number;
  readonly padX: number;
  readonly padY: number;
  readonly glyphGap: number;
  /* Text measurement widens every wave column for long localized words. */
  readonly width?: number;
  /* Phone cards use tighter lines to fit branch rows in the panel. */
  readonly rowLine?: number;
  readonly stateLine?: number;
  readonly compact?: boolean;
}

function resolveCardSpacing(): CardSpacing {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return { radius: 12, padX: 10, padY: 8, glyphGap: 6 };
  }
  const styles = getComputedStyle(document.documentElement);
  const px = (token: string, fallback: number): number => {
    const value = Number.parseFloat(styles.getPropertyValue(token));
    return Number.isFinite(value) ? value : fallback;
  };
  const space1 = px("--th-space-1", 4);
  const space2 = px("--th-space-2", 8);
  const spaceHalf = px("--th-space-0-5", 2);
  return {
    radius: px("--th-radius", 12),
    padX: space2 + spaceHalf,
    padY: space2,
    glyphGap: space1 + spaceHalf,
  };
}

// Run and node ids are free-form (observed with parens and slashes) and a
// url(#…) reference built from them computes to clip-path: none in real
// Chrome, so clip, marker and filter ids are POSITIONAL. Split panes render
// one shelf each, so the shelf's React useId (sanitized to a safe charset)
// prefixes the ids to keep them unique document-wide and surviving sibling
// unmounts.
/**
 * Per-node painted motion state, remembered at the shelf level: the first
 * paint enters once, a state change into a terminal state settles once, and
 * completion, cancellation and leaving the graph consume the flags. Merely
 * retaining a class is insufficient: display:none restarts CSS animations.
 */
export interface DagNodeMotion {
  readonly state: string;
  readonly entering: boolean;
  readonly settling: boolean;
}

export function nextDagNodeMotion(
  previous: DagNodeMotion | undefined,
  state: string,
): DagNodeMotion {
  if (previous === undefined) return { state, entering: true, settling: false };
  if (previous.state !== state) {
    const kind = nodeStatusKind(state);
    return {
      state,
      entering: false,
      settling: kind === "ok" || kind === "error",
    };
  }
  return previous;
}

/** Every card shares one local geometry, so one clip per text row serves the
 *  whole run: userSpaceOnUse clips resolve in each node's own translated
 *  space. Row 2 clips the state word. */
function rowClipId(shelfPrefix: string, runIndex: number, row: number): string {
  return `th-dag-clip-${shelfPrefix}-${runIndex}-${row}`;
}
function edgeMarkerId(shelfPrefix: string, runIndex: number): string {
  return `th-dag-arrow-${shelfPrefix}-${runIndex}`;
}
function haloFilterId(shelfPrefix: string, runIndex: number): string {
  return `th-dag-halo-${shelfPrefix}-${runIndex}`;
}
function cometFilterId(shelfPrefix: string, runIndex: number): string {
  return `th-dag-glow-${shelfPrefix}-${runIndex}`;
}

const round = (value: number): number => Math.round(value * 100) / 100;

interface CardGeometry {
  readonly width: number;
  readonly height: number;
  readonly row: number;
  readonly firstBaseline: number;
  readonly stateBaseline: number;
  readonly glyph: { readonly cx: number; readonly cy: number; readonly r: number };
  readonly labelX: number;
  readonly labelWidth: number;
}

/**
 * Card anatomy: status glyph in a left lane on the first title row, up to two
 * Label-tier title rows hanging from the glyph lane, and the Micro state word
 * on a fixed bottom row, so a status change never moves anything.
 */
function cardGeometry(fontPx: number, stateFontPx: number, spacing: CardSpacing, titleRows = 2): CardGeometry {
  const { padX, padY, glyphGap } = spacing;
  // Round, not ceil: at the default size the ratio is 1 +/- float noise.
  const width = spacing.width ?? Math.round(NODE_WIDTH * fontPx / DEFAULT_TYPE_PX);
  const row = Math.ceil(fontPx * (spacing.rowLine ?? 1.4));
  const stateRow = Math.ceil(stateFontPx * (spacing.stateLine ?? 1.4));
  // A dense wave of one-line titles needs no empty second title row. Allow
  // three extra baseline pixels so the title and state ink do not overlap.
  const stateGap = titleRows === 1 && !spacing.compact ? 3 : 0;
  // Chrome's 11px SVG text has a roughly 13px painted box. Consecutive
  // baselines therefore need a full text box, not the compact 11px row pitch;
  // the extra room belongs outside the ink, and tall runs scroll in the
  // tabpanel rather than compressing the cards.
  const height = spacing.compact
    ? padY * 2 + row * titleRows + Math.ceil(stateFontPx * 1.4)
    : padY * 2 + row * titleRows + stateGap + stateRow;
  // Pretendard's SVG ink sits slightly lower than its nominal baseline:
  // raising both compact rows one pixel balances the measured outer edges.
  const firstBaseline = padY + (spacing.compact ? row - 1 : Math.round(row * 0.75));
  const stateBaseline = spacing.compact
    ? padY + row * (titleRows + 1) + 2
    : padY + row * titleRows + stateGap + Math.round(stateRow * 0.75);
  const r = round(fontPx * 0.4);
  const labelX = Math.ceil(padX + r * 2 + glyphGap);
  return {
    width,
    height,
    row,
    firstBaseline,
    stateBaseline,
    glyph: { cx: round(padX + r), cy: round(firstBaseline - fontPx * 0.34), r },
    labelX,
    labelWidth: width - labelX - padX,
  };
}

interface GraphType {
  readonly fontPx: number;
  readonly stateFontPx: number;
  readonly width: number;
  readonly labels: ReadonlyMap<string, readonly string[]>;
}

/**
 * Titles use at most two lines. The first line takes the longest prefix
 * that fits, breaking at a word boundary when the remainder fits the
 * second line; when the capped card width cannot fit the second line, it
 * is truncated and ends with an ellipsis (U+2026).
 *
 * Fitting is a binary search over code points, so one fit costs at most
 * ceil(log2(n)) + 2 measure calls; the previous per-glyph loop measured
 * every prefix on every node and froze the main thread on long titles.
 */
export function splitNodeLabel(
  text: string,
  firstWidth: number,
  secondWidth: number,
  measure: (text: string) => number,
): readonly string[] {
  if (measure(text) <= firstWidth) return [text];
  const fit = (value: string, width: number): string => {
    if (width <= 0) return "";
    if (measure(value) <= width) return value;
    const glyphs = Array.from(value);
    let low = 0; // glyphs[0..low) fits.
    let high = glyphs.length; // glyphs[0..high) overflows (the early return proves it for `high`).
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (measure(glyphs.slice(0, mid).join("")) <= width) low = mid;
      else high = mid - 1;
    }
    return glyphs.slice(0, low).join("");
  };
  let head = fit(text, firstWidth);
  const space = head.lastIndexOf(" ");
  if (space > head.length * 0.4 && measure(text.slice(space).trimStart()) <= secondWidth) {
    head = head.slice(0, space);
  }
  let tail = text.slice(head.length).trimStart();
  if (measure(tail) > secondWidth) {
    tail = `${fit(tail, secondWidth - measure("…"))}…`;
  }
  return [head, tail];
}

function kahnLayers(nodes: readonly ActivityDagNode[]): readonly (readonly ActivityDagNode[])[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const dependsOn = new Map(
    nodes.map((node) => [node.id, node.dependsOn.filter((id) => byId.has(id))] as const),
  );
  const placed = new Set<string>();
  const layers: (readonly ActivityDagNode[])[] = [];
  let frontier = nodes.filter((node) => (dependsOn.get(node.id) ?? []).length === 0);
  while (frontier.length > 0) {
    layers.push(frontier);
    for (const node of frontier) placed.add(node.id);
    frontier = nodes.filter(
      (node) => !placed.has(node.id)
        && (dependsOn.get(node.id) ?? []).every((dependency) => placed.has(dependency)),
    );
  }
  const leftovers = nodes.filter((node) => !placed.has(node.id));
  if (leftovers.length > 0) layers.push(leftovers);
  return layers;
}

function dagLayers(run: ActivityDagRun): readonly (readonly ActivityDagNode[])[] {
  if (run.waves.length > 0) {
    const byId = new Map(run.nodes.map((node) => [node.id, node]));
    const seen = new Set<string>();
    let complete = true;
    const waveLayers = run.waves
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((wave) => wave.nodeIds.flatMap((id): readonly ActivityDagNode[] => {
        const node = byId.get(id);
        if (node === undefined || seen.has(id)) {
          complete = false;
          return [];
        }
        seen.add(id);
        return [node];
      }));
    if (complete && seen.size === run.nodes.length) return waveLayers;
  }
  return kahnLayers(run.nodes);
}

type GlyphShape = "pending" | "scheduled" | "blocked" | "running" | "check" | "error" | "stopped";

function nodeStatusKind(state: string): ReturnType<typeof statusKind> {
  return state === "cancelled" || state === "canceled" || state === "blocked"
    ? "error" : statusKind(state);
}

function glyphShape(state: string): GlyphShape {
  switch (state) {
    case "running":
      return "running";
    case "completed":
      return "check";
    case "failed":
    case "error":
      return "error";
    case "cancelled":
    case "canceled":
    case "skipped":
      return "stopped";
    case "scheduled":
      return "scheduled";
    case "blocked":
      return "blocked";
    default:
      return "pending";
  }
}

/** Round-capped zero-length dashes spaced as if the ring held `slots` dots:
 *  a full ring for scheduled, and for running a partial arc that keeps the
 *  same rhythm and ends in a readable gap, so the static glyph still reads
 *  as a spinner under reduced motion. */
function dottedRing(r: number, slots: number, dots: number): string {
  const pitch = (2 * Math.PI * r) / slots;
  const dot = 0.01;
  return Array.from({ length: dots }, (_unused, index) => {
    const gap = index === dots - 1 ? pitch * (slots - dots + 1) - dot : pitch - dot;
    return `${dot} ${round(gap)}`;
  }).join(" ");
}

/** Shape carries the state (colour is only the redundant third cue); shared
 *  by graph cards and the list rail. */
function StatusGlyph({ state, cx, cy, r }: {
  readonly state: string;
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
}) {
  const shape = glyphShape(state);
  const glyph = {
    className: `th-activity-gstatus th-activity-gstatus--${nodeStatusKind(state)}`,
    "data-glyph": shape,
    "aria-hidden": true,
    strokeWidth: round(r / 3),
  } as const;
  switch (shape) {
    case "running": {
      // E8: the running ring reads clearly at a glance — a larger violet
      // arc than the waiting glyphs, on the shared 700ms beat.
      const runningR = round(r * 1.15);
      return <circle {...glyph} cx={cx} cy={cy} r={runningR} strokeDasharray={dottedRing(runningR, 8, 6)} />;
    }
    case "scheduled":
      return <circle {...glyph} cx={cx} cy={cy} r={r} strokeDasharray={dottedRing(r, 8, 8)} />;
    case "blocked": {
      const d = round(r * Math.SQRT1_2);
      return (
        <g {...glyph}>
          <circle cx={cx} cy={cy} r={r} />
          <path d={`M${round(cx - d)} ${round(cy + d)}L${round(cx + d)} ${round(cy - d)}`} />
        </g>
      );
    }
    case "check": {
      // The chat timeline check (M20 6 9 17l-5-5 on a 24 grid) scaled to 2r
      // and drawn left to right so the stroke-dashoffset draw-in reads as a
      // hand-drawn tick.
      const s = r / 8;
      return (
        <path
          {...glyph}
          pathLength={1}
          d={`M${round(cx - 8 * s)} ${round(cy)}L${round(cx - 3 * s)} ${round(cy + 5 * s)}L${round(cx + 8 * s)} ${round(cy - 6 * s)}`}
        />
      );
    }
    case "error":
      return (
        <g {...glyph}>
          <circle className="th-activity-gstatus-wash" cx={cx} cy={cy} r={round(r * 1.15)} />
          <path d={`M${cx} ${round(cy - r * 0.55)}V${round(cy + r * 0.1)}M${cx} ${round(cy + r * 0.55)}h0.01`} />
        </g>
      );
    case "stopped":
      return (
        <g {...glyph}>
          <circle cx={cx} cy={cy} r={r} />
          <path d={`M${round(cx - r * 0.5)} ${cy}H${round(cx + r * 0.5)}`} />
        </g>
      );
    default:
      return <circle {...glyph} cx={cx} cy={cy} r={r} />;
  }
}

function InlineGlyph({ state }: { readonly state: string }) {
  return (
    <svg className="th-activity-dnode-glyph" viewBox="0 0 12 12" focusable="false">
      <StatusGlyph state={state} cx={6} cy={6} r={4.5} />
    </svg>
  );
}

interface EdgeGeometry {
  readonly edgeIndex: number;
  readonly d: string;
  readonly fulfilled: boolean;
  readonly flowing: boolean;
  readonly cometDash: number;
}

function DagGraph({ run, runIndex, clipIdPrefix, nodeHistory, onMotionEnd, active, t }: {
  readonly active: boolean;
  readonly run: ActivityDagRun;
  readonly runIndex: number;
  readonly clipIdPrefix: string;
  readonly nodeHistory: { readonly current: Map<string, DagNodeMotion> };
  readonly onMotionEnd: (key: string) => void;
  readonly t: Translate;
}) {
  const { font, fontSize, lang } = useT();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const graphRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<SVGTextElement>(null);
  const stateMeasureRef = useRef<SVGTextElement>(null);
  const firstPaintDone = useRef(false);
  const [type, setType] = useState<GraphType>({
    fontPx: DEFAULT_TYPE_PX, stateFontPx: MIN_GRAPH_TYPE_PX, width: 0, labels: new Map(),
  });
  const [viewWidth, setViewWidth] = useState(0);
  const labelKey = JSON.stringify(run.nodes.map(node => [node.id, dagNodeTitle(node)]));
  // The card metrics resolve once per render, so a token change lands on the
  // next paint together with the re-measured labels.
  const desktopSpacing = resolveCardSpacing();
  const typeTokens = getComputedStyle(document.documentElement);
  const compactFontPx = Number.parseFloat(typeTokens.getPropertyValue("--th-type-dag-compact-graph-title-size")) || 11;
  const compactStateFontPx = Number.parseFloat(typeTokens.getPropertyValue("--th-type-dag-compact-graph-state-size")) || 11.1;
  // Width selects only compact card anatomy, not a new graph topology.
  const compact = viewWidth > 0 && viewWidth < COMPACT_BREAKPOINT;
  const stateFontPx = compact ? compactStateFontPx : type.stateFontPx;
  const spacing: CardSpacing = compact
    ? {
        radius: COMPACT_RADIUS,
        padX: COMPACT_PAD_X,
        padY: COMPACT_PAD_Y,
        glyphGap: COMPACT_GLYPH_GAP,
        width: Math.max(COMPACT_MIN_CARD, type.width),
        rowLine: COMPACT_ROW_LINE,
        stateLine: COMPACT_STATE_LINE,
        compact: true,
      }
    : { ...desktopSpacing, ...(type.width > 0 ? { width: type.width } : {}) };
  const layoutFontPx = compact ? compactFontPx : type.fontPx;
  useLayoutEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const update = (): void => setViewWidth(graph.clientWidth);
    update();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(update);
    observer.observe(graph);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const probe = measureRef.current;
    const stateProbe = stateMeasureRef.current;
    if (!probe || !stateProbe) return;
    let disposed = false;
    const measure = (): void => {
      if (disposed) return;
      // Measure each tier through its own CSS class. Only the compact phone
      // overview is fixed; desktop text has a floor but no upper bound.
      probe.style.fontSize = compact ? `${compactFontPx}px` : "";
      const measured = Number.parseFloat(getComputedStyle(probe).fontSize) || fontSize * LABEL_TIER;
      const fontPx = compact ? compactFontPx
        : Math.max(MIN_GRAPH_TYPE_PX, measured);
      const measuredState = Number.parseFloat(getComputedStyle(stateProbe).fontSize) || fontSize * MICRO_TIER;
      const stateFontPx = compact ? compactStateFontPx : Math.max(MIN_GRAPH_TYPE_PX, measuredState);
      probe.style.fontSize = `${fontPx}px`;
      stateProbe.style.fontSize = `${stateFontPx}px`;
      const textWidth = (text: string, element = probe): number => {
        element.textContent = text;
        // SVG measurement includes actual fallback glyphs and letter spacing.
        // Non-layout renderers cannot measure SVG text; browser QA owns pixels.
        return typeof element.getComputedTextLength === "function"
          ? element.getComputedTextLength()
          : [...text].reduce((sum, glyph) => sum
            + Number.parseFloat(element.style.fontSize) * (/[^\u0000-\u007f]/.test(glyph) ? 1 : 0.62), 0);
      };
      const pairs: [string, string][] = JSON.parse(labelKey);
      const base = cardGeometry(fontPx, stateFontPx, {
        ...spacing,
        width: compact ? COMPACT_MIN_CARD : Math.round(NODE_WIDTH * fontPx / DEFAULT_TYPE_PX),
      });
      // Measure every localized state, rather than the current snapshot:
      // state flips must never move a card or clip its status word.
      const states = ["pending", "scheduled", "blocked", "running", "completed", "failed", "error", "cancelled", "canceled", "skipped"];
      const stateWidth = Math.max(...states.map(state => textWidth(statusLabel(t, state), stateProbe)));
      const titleWidth = Math.max(0, ...pairs.map(([, text]) => textWidth(text) / 2 + fontPx * 2));
      // Titles are short ids/labels now (the multi-KB prompt never reaches
      // this measurement), but keep a hard ceiling: the painted card may
      // never exceed twice the default card width, scaled with the measured
      // font the same way the base width is.
      const width = Math.min(base.width * 2, Math.max(base.width, Math.ceil(base.labelX + spacing.padX + Math.max(stateWidth, titleWidth) + 2)));
      const { labelWidth } = cardGeometry(fontPx, stateFontPx, { ...spacing, width });
      const labels = new Map(pairs.map(([id, text]) => [id, splitNodeLabel(text, labelWidth, labelWidth, textWidth)]));
      probe.textContent = "";
      stateProbe.textContent = "";
      stateProbe.style.fontSize = "";
      const next: GraphType = { fontPx, stateFontPx, width, labels };
      setType(previous => previous.fontPx === next.fontPx && previous.stateFontPx === next.stateFontPx && previous.width === next.width
        && JSON.stringify([...previous.labels]) === JSON.stringify([...next.labels]) ? previous : next);
    };
    measure();
    void document.fonts?.ready.then(measure);
    return () => { disposed = true; probe.style.fontSize = ""; stateProbe.style.fontSize = ""; };
  }, [font, fontSize, lang, labelKey, active, compact, viewWidth, t, compactFontPx, compactStateFontPx]);
  useLayoutEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const consumed = (event: AnimationEvent): void => {
      if (event.animationName !== "th-dag-node-enter" && event.animationName !== "th-dag-node-settle") return;
      // One-shot motion plays on the node's inner body; the node id lives on
      // the positioned outer group.
      const id = (event.target as Element).closest("[data-node]")?.getAttribute("data-node");
      if (id !== null && id !== undefined) onMotionEnd(`${run.runId}\u0000${id}`);
    };
    graph.addEventListener("animationend", consumed);
    graph.addEventListener("animationcancel", consumed);
    return () => {
      graph.removeEventListener("animationend", consumed);
      graph.removeEventListener("animationcancel", consumed);
      // Allocation/data removal can unmount the graph without a user toggle.
      // Detached nodes cannot bubble cancellation back through this listener.
      for (const [key, motion] of nodeHistory.current) {
        if (key.startsWith(`${run.runId}\u0000`)) {
          nodeHistory.current.set(key, { ...motion, entering: false, settling: false });
        }
      }
    };
  }, [run.runId, onMotionEnd, nodeHistory]);
  useLayoutEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    // Edge fades appear only on the sides that actually hide content; the
    // attribute is written directly so scrolling never re-renders the graph.
    const update = (): void => {
      const hiddenStart = graph.scrollLeft > 1;
      const hiddenEnd = graph.scrollWidth - graph.clientWidth - graph.scrollLeft > 1;
      const fade = hiddenStart && hiddenEnd ? "both" : hiddenStart ? "start" : hiddenEnd ? "end" : null;
      if (fade === null) graph.removeAttribute("data-fade");
      else if (graph.getAttribute("data-fade") !== fade) graph.setAttribute("data-fade", fade);
      // The reel has no height bound (overflow-y hides, the SVG is the
      // content), so its own scrollHeight never exceeds its clientHeight and
      // the shelf clips the visible graph instead. Walk to every ancestor
      // whose overflow can clip and take the deepest visible bottom: a
      // partially visible bottom row dissolves into the canvas at that
      // boundary instead of slicing mid-glyph. --dag-fade-lift is a measured
      // runtime offset (data, like the progress transform), not a token.
      let visibleBottom = graph.getBoundingClientRect().bottom;
      for (let ancestor = graph.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.overflowX === "visible" && style.overflowY === "visible") continue;
        visibleBottom = Math.min(visibleBottom, ancestor.getBoundingClientRect().bottom);
        observe(ancestor);
      }
      if (graph.scrollHeight - graph.clientHeight > 1) {
        visibleBottom = Math.min(visibleBottom, graph.getBoundingClientRect().top + graph.clientHeight);
      }
      const lift = Math.round(graph.getBoundingClientRect().bottom - visibleBottom);
      if (lift > 1) {
        graph.setAttribute("data-fade-bottom", "true");
        graph.style.setProperty("--dag-fade-lift", `${lift}px`);
      } else {
        graph.removeAttribute("data-fade-bottom");
        graph.style.removeProperty("--dag-fade-lift");
      }
    };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    // The test polyfill fires the callback synchronously from observe(), so
    // each target may be handed to the observer only once: the re-entrant
    // update then sees every target already observed and terminates.
    const observed = new Set<Element>();
    const observe = (target: Element): void => {
      if (observed.has(target)) return;
      observed.add(target);
      observer?.observe(target);
    };
    observe(graph);
    const canvas = graph.firstElementChild;
    if (canvas !== null) observe(canvas);
    update();
    graph.addEventListener("scroll", update, { passive: true });
    // The tabpanel owns vertical scroll: scrolling it moves the reel under
    // the clip without touching the reel's own scroll position, and scroll
    // events do not bubble, so capture every scroll in the subtree.
    document.addEventListener("scroll", update, { capture: true, passive: true });
    return () => {
      graph.removeEventListener("scroll", update);
      document.removeEventListener("scroll", update, { capture: true });
      observer?.disconnect();
    };
  }, []);
  const layers = dagLayers(run);
  const oneLineCards = compact
    && run.nodes.every(node => (type.labels.get(node.id) ?? [dagNodeTitle(node)]).length === 1);
  const geometry = cardGeometry(layoutFontPx, stateFontPx, spacing, oneLineCards ? 1 : 2);
  const { width: nodeWidth, height: nodeHeight, row, glyph } = geometry;
  const { radius } = spacing;
  const positions = new Map<
    string,
    { readonly x: number; readonly y: number; readonly layer: number }
  >();
  const typeScale = Math.max(1, layoutFontPx / DEFAULT_TYPE_PX, stateFontPx / MIN_GRAPH_TYPE_PX);
  const gapX = compact ? COMPACT_GAP_X : Math.round(GAP_X * typeScale);
  const gapY = compact ? COMPACT_GAP_Y : Math.round(GAP_Y * typeScale);
  const pad = compact ? COMPACT_PADDING : PADDING;
  layers.forEach((layer, layerIndex) =>
    layer.forEach((node, nodeIndex) =>
      positions.set(node.id, {
        x: pad + layerIndex * (nodeWidth + gapX),
        y: pad + nodeIndex * (nodeHeight + gapY),
        layer: layerIndex,
      }),
    ),
  );
  const columns = Math.max(1, layers.length);
  const rows = Math.max(1, ...layers.map((layer) => layer.length));
  const svgWidth = pad * 2 + columns * nodeWidth + (columns - 1) * gapX;
  const svgHeight = pad * 2 + rows * nodeHeight + (rows - 1) * gapY;
  const nodesById = new Map(run.nodes.map(node => [node.id, node]));
  // Agent-alive motion (halo, comet, spinner) follows real observable work:
  // a running run in the active graph, never stale or hidden data.
  const live = run.status === "running" && active;
  let firstRunning: { readonly x: number; readonly y: number; readonly layer: number } | undefined;
  for (const node of run.nodes) {
    const position = positions.get(node.id);
    if (node.state !== "running" || position === undefined) continue;
    if (firstRunning === undefined || position.layer < firstRunning.layer
      || (position.layer === firstRunning.layer && position.y < firstRunning.y)) firstRunning = position;
  }
  useLayoutEffect(() => {
    const graph = graphRef.current;
    // Hidden panels have no box: the first paint is the first visible one.
    if (graph === null || firstPaintDone.current || graph.clientWidth === 0) return undefined;
    if (firstRunning !== undefined) {
      // Always center the running node, even when a previous pass already
      // brought it inside the view: the label measurement re-render can
      // change the card width, and an "inside" check would freeze the reel
      // at the stale-width position with the running node off-center.
      // Only this container scrolls: ancestors (and the page) never move.
      const maxScroll = Math.max(0, graph.scrollWidth - graph.clientWidth);
      graph.scrollLeft = Math.min(maxScroll, Math.max(0, firstRunning.x + nodeWidth / 2 - graph.clientWidth / 2));
    }
    if (typeof requestAnimationFrame !== "function") {
      firstPaintDone.current = true;
      return undefined;
    }
    // A same-frame re-render (label measurement) re-aims before the paint.
    const frame = requestAnimationFrame(() => { firstPaintDone.current = true; });
    return () => cancelAnimationFrame(frame);
  });
  const history = nodeHistory.current;
  const nodeMotion = new Map<string, DagNodeMotion>();
  for (const node of run.nodes) {
    const key = `${run.runId}\u0000${node.id}`;
    const motion = active && !reducedMotion
      ? nextDagNodeMotion(history.get(key), node.state)
      : { state: node.state, entering: false, settling: false };
    nodeMotion.set(node.id, motion);
    // A reduced-motion paint consumes its one-shot without waiting for a
    // nonexistent animationend. A hidden node has not had its first paint.
    if (active) history.set(key, motion);
  }
  const edges = run.edges.flatMap((edge, edgeIndex): readonly EdgeGeometry[] => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (from === undefined || to === undefined) return [];
    // Fulfilled describes the dependency, not the destination's outcome.
    // Always recompute from this snapshot, including retries and stale nodes.
    const fulfilled = nodesById.get(edge.from)?.state === "completed";
    const flowing = fulfilled && nodesById.get(edge.to)?.state === "running"
      && run.status === "running" && active;
    // Horizontal tangents at both ends: dependencies leave a card's right
    // edge and arrive at the next card's left edge as one smooth curve.
    const x1 = from.x + nodeWidth;
    const y1 = from.y + nodeHeight / 2;
    const x2 = to.x;
    const y2 = to.y + nodeHeight / 2;
    const dx = Math.max(gapX / 2, Math.abs(x2 - x1) / 2);
    const d = `M${round(x1)} ${round(y1)}C${round(x1 + dx)} ${round(y1)} ${round(x2 - dx)} ${round(y2)} ${round(x2)} ${round(y2)}`;
    // pathLength=100 normalizes the dash to a fraction of this edge. Keep a
    // short edge's comet at half its length, but cap longer trails near 6px.
    const cometDash = round(Math.min(50, 600 / Math.hypot(x2 - x1, y2 - y1)));
    return [{ edgeIndex, d, fulfilled, flowing, cometDash }];
  });
  return (
    <div ref={graphRef} className="th-activity-graph" data-live={live ? "true" : undefined}>
      <svg role="img" aria-label={run.name} width={svgWidth} height={svgHeight}>
        <text ref={measureRef} className="th-activity-glabel" visibility="hidden" aria-hidden="true" />
        <text ref={stateMeasureRef} className="th-activity-gstate" visibility="hidden" aria-hidden="true" />
        <defs>
          {["", "-fulfilled"].map(variant => (
            <marker
              key={variant}
              id={`${edgeMarkerId(clipIdPrefix, runIndex)}${variant}`}
              viewBox="0 0 5 4"
              refX={5}
              refY={2}
              markerWidth={5}
              markerHeight={4}
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path d="M0,0L5,2L0,4Z" className={`th-activity-gedge-head${variant ? " th-activity-gedge-head--fulfilled" : ""}`} />
            </marker>
          ))}
          {[0, 1, 2].map(clipRow => (
            <clipPath key={clipRow} id={rowClipId(clipIdPrefix, runIndex, clipRow)}>
              <rect x={geometry.labelX} y={0} width={geometry.labelWidth} height={nodeHeight} />
            </clipPath>
          ))}
          <filter
            id={haloFilterId(clipIdPrefix, runIndex)}
            filterUnits="userSpaceOnUse"
            x={-PADDING}
            y={-PADDING}
            width={nodeWidth + PADDING * 2}
            height={nodeHeight + PADDING * 2}
          >
            <feGaussianBlur stdDeviation={HALO_BLUR} />
          </filter>
          <filter id={cometFilterId(clipIdPrefix, runIndex)} filterUnits="userSpaceOnUse" x={0} y={0} width={svgWidth} height={svgHeight}>
            <feGaussianBlur stdDeviation={COMET_BLUR} />
          </filter>
        </defs>
        {edges.map(({ edgeIndex, d, fulfilled, flowing }) => (
          <path
            key={edgeIndex}
            className={`th-activity-gedge${fulfilled ? " th-activity-gedge--fulfilled" : ""}${flowing ? " th-activity-gedge--flow" : ""}`}
            d={d}
            markerEnd={`url(#${edgeMarkerId(clipIdPrefix, runIndex)}${fulfilled ? "-fulfilled" : ""})`}
          />
        ))}
        {/* The comet rides above every dependency line and dives under the
            destination card; reduced motion renders none (the fulfilled line
            and the running glyph and word still carry the state). */}
        {reducedMotion ? null : edges.filter(edge => edge.flowing).flatMap(({ edgeIndex, d, cometDash }) => [
          <path
            key={`glow-${edgeIndex}`}
            className="th-activity-gedge-glow"
            d={d}
            pathLength={100}
            style={{ strokeDasharray: `${cometDash} 100` }}
            filter={`url(#${cometFilterId(clipIdPrefix, runIndex)})`}
          />,
          <path key={`comet-${edgeIndex}`} className="th-activity-gedge-comet" d={d} pathLength={100}
            style={{ strokeDasharray: `${cometDash} 100` }} />,
        ])}
        {run.nodes.flatMap((node) => {
          const position = positions.get(node.id);
          if (position === undefined) return [];
          const kind = nodeStatusKind(node.state);
          const motion = nodeMotion.get(node.id);
          const stateClass = [
            "th-activity-gnode",
            `th-activity-gnode--${kind}`,
            // Binding user decision (2026-09-26): cancelled nodes join the
            // failed/error red-border set; skipped and the waiting states
            // keep the neutral stroke.
            ...(node.state === "cancelled" || node.state === "canceled" ? ["th-activity-gnode--cancelled"] : []),
            ...(motion?.entering ? ["th-activity-gnode--enter"] : []),
            ...(motion?.settling ? ["th-activity-gnode--settle"] : []),
          ].join(" ");
          const lines = type.labels.get(node.id) ?? [dagNodeTitle(node)];
          // A one-line title can sit in a two-row card when another node in
          // the run wraps. Share the same card/grid geometry, but centre its
          // smaller ink group around the state instead of leaving a blank
          // title row between them.
          const singleLineInTallCard = compact && lines.length === 1 && !oneLineCards;
          const titleShift = singleLineInTallCard ? Math.ceil(row / 2) : 0;
          const stateShift = singleLineInTallCard ? Math.floor(row / 2) : 0;
          return [
            // The outer group owns position (transform attribute) and never
            // animates; enter/settle motion plays on the inner body so a CSS
            // transform can never override the layout.
            <g
              key={node.id}
              className={stateClass}
              data-node={node.id}
              data-layer={position.layer}
              transform={`translate(${position.x}, ${position.y})`}
            >
              <title>{`${node.prompt} (${statusLabel(t, node.state)})`}</title>
              <g className="th-activity-gbody">
                {kind === "running" && live && !reducedMotion && (
                  <rect
                    className="th-activity-gnode-halo"
                    x={-HALO_SPREAD}
                    y={-HALO_SPREAD}
                    width={nodeWidth + HALO_SPREAD * 2}
                    height={nodeHeight + HALO_SPREAD * 2}
                    rx={radius + HALO_SPREAD}
                    filter={`url(#${haloFilterId(clipIdPrefix, runIndex)})`}
                  />
                )}
                <rect className="th-activity-gnode-card" width={nodeWidth} height={nodeHeight} rx={radius} />
                {lines.map((line, lineIndex) => (
                  <text
                    key={lineIndex}
                    className="th-activity-glabel"
                    style={{ fontSize: `${layoutFontPx}px` }}
                    x={geometry.labelX}
                    y={geometry.firstBaseline + titleShift + lineIndex * row}
                    clipPath={`url(#${rowClipId(clipIdPrefix, runIndex, lineIndex)})`}
                  >
                    {line}
                  </text>
                ))}
                <text
                  className="th-activity-gstate"
                  style={{ fontSize: `${stateFontPx}px` }}
                  x={geometry.labelX}
                  y={geometry.stateBaseline - stateShift}
                  clipPath={`url(#${rowClipId(clipIdPrefix, runIndex, 2)})`}
                >
                  {statusLabel(t, node.state)}
                </text>
                <StatusGlyph state={node.state} cx={glyph.cx} cy={glyph.cy + titleShift} r={glyph.r} />
              </g>
            </g>,
          ];
        })}
      </svg>
    </div>
  );
}

function DagList({ run, live, t }: {
  readonly run: ActivityDagRun;
  readonly live: boolean;
  readonly t: Translate;
}) {
  return (
    <ul className="th-activity-dagnodes" data-live={live ? "true" : undefined}>
      {run.nodes.map((node) => (
        <li key={node.id} className={`th-activity-dnode th-activity-dnode--${nodeStatusKind(node.state)}`}>
          <span className="th-activity-dnode-rail" aria-hidden="true">
            <InlineGlyph state={node.state} />
          </span>
          <span className="th-activity-dnode-label" title={node.prompt}>
            {dagNodeTitle(node)}
          </span>
          <span className={`th-activity-dnode-state th-activity-dnode-state--${nodeStatusKind(node.state)}`}>{statusLabel(t, node.state)}</span>
        </li>
      ))}
    </ul>
  );
}

export function DagSection({ dags, t, view, onViewChange, clipIdPrefix, nodeHistory, onMotionEnd, active }: {
  readonly active: boolean;
  readonly dags: readonly ActivityDagRun[];
  readonly t: Translate;
  readonly view: DagView;
  readonly onViewChange: (view: DagView) => void;
  readonly clipIdPrefix: string;
  readonly nodeHistory: { readonly current: Map<string, DagNodeMotion> };
  readonly onMotionEnd: (key: string) => void;
}) {
  // One toggle drives every run: it rides in a lone run's header row and
  // sits above the runs when there are several.
  const toolbar = (
    <div className="th-activity-dag-toolbar">
      <div className="th-activity-dag-view" role="group" aria-label={t("activity.viewToggle")} data-view-mode={view}>
        <span className="th-activity-dag-view-thumb" aria-hidden="true" />
        {(["list", "graph"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className="th-activity-view-btn th-activity-dag-view-btn"
            data-view={mode}
            aria-pressed={view === mode}
            onClick={() => onViewChange(mode)}
          >
            {t(mode === "list" ? "activity.list" : "activity.graph")}
          </button>
        ))}
      </div>
    </div>
  );
  const inlineToolbar = dags.length === 1;
  return (
    <section className="th-activity-section th-activity-dag-section">
      {!inlineToolbar && toolbar}
      {dags.map((run, runIndex) => {
        const total = run.counts.total;
        // The contracted numerator is the run document's completed count:
        // failed, skipped and cancelled nodes are finished work, never
        // completed work, so neither the bar nor the header may add them.
        const completed = run.counts.completed;
        const progress = total > 0 ? Math.min(1, Math.max(0, completed / total)) : 0;
        return (
          <div key={run.runId} className="th-activity-dag">
            <div className="th-activity-dag-head">
              <div className="th-activity-dag-title">
                <span className="th-activity-dag-name">{run.name}</span>
                <ActivityChip kind={statusKind(run.status)} label={statusLabel(t, run.status)} />
                <span className="th-activity-dag-counts">
                  {t("activity.dagCounts", { done: completed, total })}
                </span>
                {inlineToolbar && toolbar}
              </div>
              <div className="th-activity-dag-progress" data-live={run.status === "running" ? "true" : undefined} aria-hidden="true">
                <span className="th-activity-dag-progress-fill" style={{ transform: `scaleX(${progress})` }} />
              </div>
            </div>
            {view === "graph" ? (
              <DagGraph run={run} runIndex={runIndex} clipIdPrefix={clipIdPrefix} nodeHistory={nodeHistory} onMotionEnd={onMotionEnd} active={active} t={t} />
            ) : (
              <DagList run={run} live={run.status === "running" && active} t={t} />
            )}
          </div>
        );
      })}
    </section>
  );
}
