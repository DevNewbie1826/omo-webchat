import { useLayoutEffect, useRef, useState } from "react";
import { useT, type Translate } from "../../i18n";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { statusKind, statusLabel, type DagView } from "./activityShelfModel";
import { ActivityChip } from "./activityShelfSections";
import type { ActivityDagNode, ActivityDagRun } from "./activityTypes";

/*
 * Living-graph geometry (v2). Every value is at the default Label tier (13px
 * base) and the card scales with the measured Label font, so the user's type
 * setting grows width, row pitch and the glyph lane together. Each node owns
 * one cell of the wave/layer grid, so dense runs (64 nodes) never overlap:
 * GAP_Y keeps stacked cards clear of a running neighbour's halo (HALO_SPREAD
 * plus the blur's visible falloff), GAP_X leaves room for the bezier
 * curvature and the arrowhead, and PADDING keeps an edge node's halo inside
 * the SVG viewport. The card's radius/padding/gap are NOT constants: they
 * resolve from the --th-* radius/spacing tokens below, so a token change
 * moves the painted card, the glyph lane and the label clips together.
 */
const NODE_WIDTH = 176;
const GAP_X = 48;
const GAP_Y = 16;
const PADDING = 12;
const HALO_SPREAD = 2;
const HALO_BLUR = 4;
const COMET_BLUR = 1.5;
const LABEL_TIER = 0.8571;
const MICRO_TIER = 0.7857;
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
    const kind = statusKind(state);
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
function cardGeometry(fontPx: number, spacing: Pick<CardSpacing, "padX" | "padY" | "glyphGap">): CardGeometry {
  const { padX, padY, glyphGap } = spacing;
  // Round, not ceil: at the default size the ratio is 1 +/- float noise.
  const width = Math.round(NODE_WIDTH * fontPx / DEFAULT_TYPE_PX);
  const row = Math.ceil(fontPx * 1.4);
  const stateRow = Math.ceil(fontPx * (MICRO_TIER / LABEL_TIER) * 1.4);
  const height = padY * 2 + row * 2 + stateRow;
  const firstBaseline = padY + Math.round(row * 0.75);
  const stateBaseline = padY + row * 2 + Math.round(stateRow * 0.75);
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
  readonly labels: ReadonlyMap<string, readonly string[]>;
}

/**
 * P6: node titles wrap onto two lines when useful instead of a blind
 * fixed-character truncation. The break prefers a word boundary; only a
 * remainder that still overflows line 2 is ellipsized, and the <title>
 * always carries the full text.
 */
export function splitNodeLabel(
  text: string,
  firstWidth: number,
  secondWidth: number,
  measure: (text: string) => number,
): readonly string[] {
  if (measure(text) <= firstWidth) return [text];
  const fit = (value: string, width: number): string => {
    let result = "";
    for (const glyph of value) {
      if (measure(result + glyph) > width) break;
      result += glyph;
    }
    return result;
  };
  let head = fit(text, firstWidth);
  const space = head.lastIndexOf(" ");
  if (space > head.length * 0.4) head = head.slice(0, space);
  let tail = text.slice(head.length).trimStart();
  if (measure(tail) > secondWidth) tail = `${fit(tail, secondWidth - measure("…"))}…`;
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
    className: `th-activity-gstatus th-activity-gstatus--${statusKind(state)}`,
    "data-glyph": shape,
    "aria-hidden": true,
    strokeWidth: round(r / 3),
  } as const;
  switch (shape) {
    case "running":
      return <circle {...glyph} cx={cx} cy={cy} r={r} strokeDasharray={dottedRing(r, 8, 6)} />;
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
  const firstPaintDone = useRef(false);
  const [type, setType] = useState<GraphType>({ fontPx: DEFAULT_TYPE_PX, labels: new Map() });
  const labelKey = JSON.stringify(run.nodes.map(node => [node.id, node.label ?? node.prompt]));
  // The card metrics resolve once per render, so a token change lands on the
  // next paint together with the re-measured labels.
  const { radius, padX, padY, glyphGap } = resolveCardSpacing();
  useLayoutEffect(() => {
    const probe = measureRef.current;
    if (!probe) return;
    let disposed = false;
    const measure = (): void => {
      if (disposed) return;
      const fontPx = Number.parseFloat(getComputedStyle(probe).fontSize) || fontSize * LABEL_TIER;
      const { labelWidth } = cardGeometry(fontPx, { padX, padY, glyphGap });
      const textWidth = (text: string): number => {
        probe.textContent = text;
        // SVG measurement includes actual fallback glyphs and letter spacing.
        // Non-layout renderers cannot measure SVG text; browser QA owns pixels.
        return typeof probe.getComputedTextLength === "function"
          ? probe.getComputedTextLength()
          : [...text].reduce((sum, glyph) => sum + fontPx * (/[^\u0000-\u007f]/.test(glyph) ? 1 : 0.62), 0);
      };
      const pairs: [string, string][] = JSON.parse(labelKey);
      // Both title rows hang from the glyph lane, so they share one width.
      const labels = new Map(pairs.map(([id, text]) => [id, splitNodeLabel(text, labelWidth, labelWidth, textWidth)]));
      probe.textContent = "";
      const next: GraphType = { fontPx, labels };
      setType(previous => previous.fontPx === next.fontPx
        && JSON.stringify([...previous.labels]) === JSON.stringify([...next.labels]) ? previous : next);
    };
    measure();
    void document.fonts?.ready.then(measure);
    return () => { disposed = true; };
  }, [font, fontSize, lang, labelKey, active, padX, padY, glyphGap]);
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
  const geometry = cardGeometry(type.fontPx, { padX, padY, glyphGap });
  const { width: nodeWidth, height: nodeHeight, row, glyph } = geometry;
  const layers = dagLayers(run);
  const positions = new Map<
    string,
    { readonly x: number; readonly y: number; readonly layer: number }
  >();
  layers.forEach((layer, layerIndex) =>
    layer.forEach((node, nodeIndex) =>
      positions.set(node.id, {
        x: PADDING + layerIndex * (nodeWidth + GAP_X),
        y: PADDING + nodeIndex * (nodeHeight + GAP_Y),
        layer: layerIndex,
      }),
    ),
  );
  const columns = Math.max(1, layers.length);
  const rows = Math.max(1, ...layers.map((layer) => layer.length));
  const svgWidth = PADDING * 2 + columns * nodeWidth + (columns - 1) * GAP_X;
  const svgHeight = PADDING * 2 + rows * nodeHeight + (rows - 1) * GAP_Y;
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
      const viewStart = graph.scrollLeft;
      const viewEnd = viewStart + graph.clientWidth;
      if (firstRunning.x < viewStart || firstRunning.x + nodeWidth > viewEnd) {
        // Only this container scrolls: ancestors (and the page) never move.
        const maxScroll = Math.max(0, graph.scrollWidth - graph.clientWidth);
        graph.scrollLeft = Math.min(maxScroll, Math.max(0, firstRunning.x + nodeWidth / 2 - graph.clientWidth / 2));
      }
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
    const dx = Math.max(GAP_X / 2, Math.abs(x2 - x1) / 2);
    const d = `M${round(x1)} ${round(y1)}C${round(x1 + dx)} ${round(y1)} ${round(x2 - dx)} ${round(y2)} ${round(x2)} ${round(y2)}`;
    return [{ edgeIndex, d, fulfilled, flowing }];
  });
  return (
    <div ref={graphRef} className="th-activity-graph" data-live={live ? "true" : undefined}>
      <svg role="img" aria-label={run.name} width={svgWidth} height={svgHeight}>
        <text ref={measureRef} className="th-activity-glabel" visibility="hidden" aria-hidden="true" />
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
        {reducedMotion ? null : edges.filter(edge => edge.flowing).flatMap(({ edgeIndex, d }) => [
          <path
            key={`glow-${edgeIndex}`}
            className="th-activity-gedge-glow"
            d={d}
            pathLength={100}
            filter={`url(#${cometFilterId(clipIdPrefix, runIndex)})`}
          />,
          <path key={`comet-${edgeIndex}`} className="th-activity-gedge-comet" d={d} pathLength={100} />,
        ])}
        {run.nodes.flatMap((node) => {
          const position = positions.get(node.id);
          if (position === undefined) return [];
          const kind = statusKind(node.state);
          const motion = nodeMotion.get(node.id);
          const stateClass = [
            "th-activity-gnode",
            `th-activity-gnode--${kind}`,
            ...(motion?.entering ? ["th-activity-gnode--enter"] : []),
            ...(motion?.settling ? ["th-activity-gnode--settle"] : []),
          ].join(" ");
          const lines = type.labels.get(node.id) ?? [node.label ?? node.prompt];
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
                    x={geometry.labelX}
                    y={geometry.firstBaseline + lineIndex * row}
                    clipPath={`url(#${rowClipId(clipIdPrefix, runIndex, lineIndex)})`}
                  >
                    {line}
                  </text>
                ))}
                <text
                  className="th-activity-gstate"
                  x={geometry.labelX}
                  y={geometry.stateBaseline}
                  clipPath={`url(#${rowClipId(clipIdPrefix, runIndex, 2)})`}
                >
                  {statusLabel(t, node.state)}
                </text>
                <StatusGlyph state={node.state} cx={glyph.cx} cy={glyph.cy} r={glyph.r} />
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
        <li key={node.id} className={`th-activity-dnode th-activity-dnode--${statusKind(node.state)}`}>
          <span className="th-activity-dnode-rail" aria-hidden="true">
            <InlineGlyph state={node.state} />
          </span>
          <span className="th-activity-dnode-label" title={node.prompt}>
            {node.label ?? node.prompt}
          </span>
          <span className="th-activity-dnode-state">{statusLabel(t, node.state)}</span>
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
