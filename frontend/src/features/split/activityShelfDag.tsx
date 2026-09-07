import { useLayoutEffect, useRef, useState } from "react";
import { useT, type Translate } from "../../i18n";
import { statusKind, statusLabel, type DagView } from "./activityShelfModel";
import { ActivityChip } from "./activityShelfSections";
import type { ActivityDagNode, ActivityDagRun } from "./activityTypes";

const NODE_WIDTH = 140;
const NODE_HEIGHT = 60;
const GAP_X = 24;
const GAP_Y = 12;
const PADDING = 6;
const LABEL_X = 8;
/** The measured title font determines both the row pitch and glyph lane. */
const DEFAULT_TYPE_PX = 13 * 0.7857;

// Run and node ids are free-form (observed with parens and slashes) and a
// url(#…) reference built from them computes to clip-path: none in real
// Chrome, so clip ids are POSITIONAL. Split panes render one shelf each, so
// the shelf's React useId (sanitized to a safe charset) prefixes the ids to
// keep them unique document-wide and surviving sibling unmounts.
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

function nodeClipId(shelfPrefix: string, runIndex: number, nodeIndex: number): string {
  return `th-dag-clip-${shelfPrefix}-${runIndex}-${nodeIndex}`;
}
function edgeMarkerId(shelfPrefix: string, runIndex: number): string {
  return `th-dag-arrow-${shelfPrefix}-${runIndex}`;
}

interface GraphType {
  readonly width: number;
  readonly height: number;
  readonly fontPx: number;
  readonly row: number;
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

/**
 * Non-colour status mark inside a graph node: a check for done, an
 * exclamation for failed, a rotating open ring for running (the rotation is
 * the one continuous running motion; hidden panels render nothing and
 * reduced motion keeps the static ring). Muted states carry no glyph; every
 * node also shows its state as visible localized text.
 */
function NodeStatusGlyph({ state, width, fontPx, baseline }: {
  readonly state: string;
  readonly width: number;
  readonly fontPx: number;
  readonly baseline: number;
}) {
  const kind = statusKind(state);
  if (kind === "ok") {
    return (
      <text
        className="th-activity-gstatus th-activity-gstatus--ok"
        aria-hidden="true"
        x={width - LABEL_X - fontPx}
        y={baseline}
      >
        ✓
      </text>
    );
  }
  if (kind === "error") {
    return (
      <text
        className="th-activity-gstatus th-activity-gstatus--error"
        aria-hidden="true"
        x={width - LABEL_X - fontPx}
        y={baseline}
      >
        !
      </text>
    );
  }
  if (kind === "running") {
    return (
      <circle
        className="th-activity-gstatus th-activity-gstatus--running"
        aria-hidden="true"
        cx={width - LABEL_X - fontPx / 2}
        cy={baseline - fontPx / 2}
        r={fontPx / 2}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeDasharray="23 8"
      />
    );
  }
  return null;
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
  const graphRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<SVGTextElement>(null);
  const [type, setType] = useState<GraphType>({ width: NODE_WIDTH, height: NODE_HEIGHT, fontPx: DEFAULT_TYPE_PX, row: 16, labels: new Map() });
  const labelKey = JSON.stringify(run.nodes.map(node => [node.id, node.label ?? node.prompt]));
  useLayoutEffect(() => {
    const probe = measureRef.current;
    if (!probe) return;
    let disposed = false;
    const measure = (): void => {
      if (disposed) return;
      const computed = getComputedStyle(probe);
      const fontPx = Number.parseFloat(computed.fontSize) || fontSize * 0.7857;
      const width = Math.ceil(NODE_WIDTH * fontPx / DEFAULT_TYPE_PX);
      const row = Math.ceil(fontPx * 1.6);
      const textWidth = (text: string): number => {
        probe.textContent = text;
        // SVG measurement includes actual fallback glyphs and letter spacing.
        // Non-layout renderers cannot measure SVG text; browser QA owns pixels.
        return typeof probe.getComputedTextLength === "function"
          ? probe.getComputedTextLength()
          : [...text].reduce((sum, glyph) => sum + fontPx * (/[^\u0000-\u007f]/.test(glyph) ? 1 : 0.62), 0);
      };
      const pairs: [string, string][] = JSON.parse(labelKey);
      const labels = new Map(pairs.map(([id, text]) => [id, splitNodeLabel(text, width - LABEL_X * 2 - fontPx - 6, width - LABEL_X * 2, textWidth)]));
      probe.textContent = "";
      const next = { width, height: row * 3 + 12, fontPx, row, labels };
      setType(previous => JSON.stringify({ ...previous, labels: [...previous.labels] }) === JSON.stringify({ ...next, labels: [...labels] }) ? previous : next);
    };
    measure();
    void document.fonts?.ready.then(measure);
    return () => { disposed = true; };
  }, [font, fontSize, lang, labelKey, active]);
  useLayoutEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const consumed = (event: AnimationEvent): void => {
      if (event.animationName !== "th-dag-node-enter" && event.animationName !== "th-dag-node-settle") return;
      const id = (event.target as Element).getAttribute("data-node");
      if (id !== null) onMotionEnd(`${run.runId}\u0000${id}`);
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
  const { width: nodeWidth, height: nodeHeight, fontPx, row } = type;
  const firstY = fontPx + 6;
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
  const nodesById = new Map(run.nodes.map(node => [node.id, node]));
  const history = nodeHistory.current;
  const nodeMotion = new Map<string, DagNodeMotion>();
  for (const node of run.nodes) {
    const key = `${run.runId}\u0000${node.id}`;
    const motion = nextDagNodeMotion(history.get(key), node.state);
    nodeMotion.set(node.id, motion);
    history.set(key, motion);
  }
  return (
    <div ref={graphRef} className="th-activity-graph">
      <svg
        role="img"
        aria-label={run.name}
        width={PADDING * 2 + columns * nodeWidth + (columns - 1) * GAP_X}
        height={PADDING * 2 + rows * nodeHeight + (rows - 1) * GAP_Y}
      >
        <text ref={measureRef} className="th-activity-glabel" visibility="hidden" aria-hidden="true" />
        <defs>
          {["", "-fulfilled"].map(variant => (
            <marker
              key={variant}
              id={`${edgeMarkerId(clipIdPrefix, runIndex)}${variant}`}
              viewBox="0 0 8 6"
              refX={7}
              refY={3}
              markerWidth={7}
              markerHeight={6}
              orient="auto"
            >
              <path d="M0,0L8,3L0,6Z" className={`th-activity-gedge-head${variant ? " th-activity-gedge-head--fulfilled" : ""}`} />
            </marker>
          ))}
          {run.nodes.flatMap((node, nodeIndex) => {
            const position = positions.get(node.id);
            if (position === undefined) return [];
            return [
              ...[0, 1].map(line => (
                <clipPath key={`${node.id}-${line}`} id={`${nodeClipId(clipIdPrefix, runIndex, nodeIndex)}-${line}`}>
                  <rect x={LABEL_X} y={0} width={nodeWidth - LABEL_X * 2 - (line === 0 ? fontPx + 6 : 0)} height={nodeHeight} />
                </clipPath>
              )),
            ];
          })}
        </defs>
        {run.edges.flatMap((edge) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (from === undefined || to === undefined) return [];
          // Fulfilled describes the dependency, not the destination's outcome.
          // Always recompute from this snapshot, including retries and stale nodes.
          const fulfilled = nodesById.get(edge.from)?.state === "completed";
          const flowing = fulfilled && nodesById.get(edge.to)?.state === "running"
            && run.status === "running" && active;
          return [
            <line
              key={`${edge.from}->${edge.to}`}
              className={`th-activity-gedge${fulfilled ? " th-activity-gedge--fulfilled" : ""}${flowing ? " th-activity-gedge--flow" : ""}`}
              x1={from.x + nodeWidth}
              y1={from.y + nodeHeight / 2}
              x2={to.x}
              y2={to.y + nodeHeight / 2}
              markerEnd={`url(#${edgeMarkerId(clipIdPrefix, runIndex)}${fulfilled ? "-fulfilled" : ""})`}
            />,
          ];
        })}
        {run.nodes.flatMap((node, nodeIndex) => {
          const position = positions.get(node.id);
          if (position === undefined) return [];
          const motion = nodeMotion.get(node.id);
          const stateClass = [
            "th-activity-gnode",
            `th-activity-gnode--${statusKind(node.state)}`,
            ...(motion?.entering ? ["th-activity-gnode--enter"] : []),
            ...(motion?.settling ? ["th-activity-gnode--settle"] : []),
          ].join(" ");
          const lines = type.labels.get(node.id) ?? [node.label ?? node.prompt];
          const clipId = nodeClipId(clipIdPrefix, runIndex, nodeIndex);
          return [
            <g
              key={node.id}
              className={stateClass}
              data-node={node.id}
              data-layer={position.layer}
              transform={`translate(${position.x}, ${position.y})`}
            >
              <title>{`${node.prompt} (${statusLabel(t, node.state)})`}</title>
              <rect width={nodeWidth} height={nodeHeight} rx={6} />
              {lines.map((line, lineIndex) => (
                <text
                  key={lineIndex}
                  className="th-activity-glabel"
                  x={LABEL_X}
                  y={firstY + lineIndex * row}
                  clipPath={`url(#${clipId}-${lineIndex})`}
                >
                  {line}
                </text>
              ))}
              <text className="th-activity-gstate" x={LABEL_X} y={firstY + row * 2}>
                {statusLabel(t, node.state)}
              </text>
              <NodeStatusGlyph state={node.state} width={nodeWidth} fontPx={fontPx} baseline={firstY} />
            </g>,
          ];
        })}
      </svg>
    </div>
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
  return (
    <section className="th-activity-section">
      <div className="th-activity-dag-toolbar">
        <div className="th-activity-view" role="group" aria-label={t("activity.viewToggle")}>
          {(["list", "graph"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className="th-activity-view-btn"
              data-view={mode}
              aria-pressed={view === mode}
              onClick={() => onViewChange(mode)}
            >
              {t(mode === "list" ? "activity.list" : "activity.graph")}
            </button>
          ))}
        </div>
      </div>
      {dags.map((run, runIndex) => (
        <div key={run.runId} className="th-activity-dag">
          <div className="th-activity-dag-head">
            <span className="th-activity-dag-name">{run.name}</span>
            <ActivityChip kind={statusKind(run.status)} label={statusLabel(t, run.status)} />
            <span className="th-activity-dag-counts">
              {t("activity.dagCounts", { done: run.counts.completed, total: run.counts.total })}
            </span>
          </div>
          {view === "graph" ? (
            <DagGraph run={run} runIndex={runIndex} clipIdPrefix={clipIdPrefix} nodeHistory={nodeHistory} onMotionEnd={onMotionEnd} active={active} t={t} />
          ) : (
            <ul className="th-activity-dagnodes">
              {run.nodes.map((node) => (
                <li key={node.id} className="th-activity-dnode">
                  <span className="th-activity-dnode-label" title={node.prompt}>
                    {node.label ?? node.prompt}
                  </span>
                  <ActivityChip kind={statusKind(node.state)} label={statusLabel(t, node.state)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}
