import type { Translate } from "../../i18n";
import { statusKind, statusLabel, type DagView } from "./activityShelfModel";
import { ActivityChip } from "./activityShelfSections";
import type { ActivityDagNode, ActivityDagRun } from "./activityTypes";

const NODE_WIDTH = 118;
const NODE_HEIGHT = 30;
const GAP_X = 26;
const GAP_Y = 10;
const PADDING = 6;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Glyph zone starts at NODE_WIDTH - 15; the label clip ends 7px earlier so
// no script width (Korean labels are ~2x the mono Latin advance) can run
// under the status mark. SVG <text> ignores CSS overflow, so the clip is a
// real clipPath, and the <title> keeps the full prompt accessible.
const LABEL_X = 7;
const LABEL_CLIP_WIDTH = NODE_WIDTH - 29;

// Run and node ids are free-form (observed with parens and slashes) and a
// url(#…) reference built from them computes to clip-path: none in real
// Chrome, so clip ids are POSITIONAL. Split panes render one shelf each, so
// the shelf's React useId (sanitized to a safe charset) prefixes the ids to
// keep them unique document-wide and surviving sibling unmounts.
function nodeClipId(shelfPrefix: string, runIndex: number, nodeIndex: number): string {
  return `th-dag-clip-${shelfPrefix}-${runIndex}-${nodeIndex}`;
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
 * Non-colour status mark inside a graph node (DESIGN.md's status rule applied
 * to the shelf's finished-state rendering): a check for done, an exclamation
 * for failed, an open ring for running - static, like the reduced-motion tool
 * glyph. Muted states carry no glyph; the localized word lives in the node's
 * <title>.
 */
function NodeStatusGlyph({ state }: { readonly state: string }) {
  const kind = statusKind(state);
  if (kind === "ok") {
    return (
      <text
        className="th-activity-gstatus th-activity-gstatus--ok"
        aria-hidden="true"
        x={NODE_WIDTH - 15}
        y={19}
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
        x={NODE_WIDTH - 14}
        y={19}
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
        cx={NODE_WIDTH - 11}
        cy={NODE_HEIGHT / 2}
        r={5}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeDasharray="23 8"
      />
    );
  }
  return null;
}

function DagGraph({ run, runIndex, clipIdPrefix, t }: {
  readonly run: ActivityDagRun;
  readonly runIndex: number;
  readonly clipIdPrefix: string;
  readonly t: Translate;
}) {
  const layers = dagLayers(run);
  const positions = new Map<
    string,
    { readonly x: number; readonly y: number; readonly layer: number }
  >();
  layers.forEach((layer, layerIndex) =>
    layer.forEach((node, nodeIndex) =>
      positions.set(node.id, {
        x: PADDING + layerIndex * (NODE_WIDTH + GAP_X),
        y: PADDING + nodeIndex * (NODE_HEIGHT + GAP_Y),
        layer: layerIndex,
      }),
    ),
  );
  const columns = Math.max(1, layers.length);
  const rows = Math.max(1, ...layers.map((layer) => layer.length));
  return (
    <div className="th-activity-graph">
      <svg
        role="img"
        aria-label={run.name}
        width={PADDING * 2 + columns * NODE_WIDTH + (columns - 1) * GAP_X}
        height={PADDING * 2 + rows * NODE_HEIGHT + (rows - 1) * GAP_Y}
      >
        <defs>
          {run.nodes.flatMap((node, nodeIndex) => {
            const position = positions.get(node.id);
            if (position === undefined) return [];
            return [
              <clipPath key={node.id} id={nodeClipId(clipIdPrefix, runIndex, nodeIndex)}>
                <rect x={LABEL_X} y={0} width={LABEL_CLIP_WIDTH} height={NODE_HEIGHT} />
              </clipPath>,
            ];
          })}
        </defs>
        {run.edges.flatMap((edge) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (from === undefined || to === undefined) return [];
          return [
            <line
              key={`${edge.from}->${edge.to}`}
              className="th-activity-gedge"
              x1={from.x + NODE_WIDTH}
              y1={from.y + NODE_HEIGHT / 2}
              x2={to.x}
              y2={to.y + NODE_HEIGHT / 2}
            />,
          ];
        })}
        {run.nodes.flatMap((node, nodeIndex) => {
          const position = positions.get(node.id);
          if (position === undefined) return [];
          return [
            <g
              key={node.id}
              className={`th-activity-gnode th-activity-gnode--${statusKind(node.state)}`}
              data-node={node.id}
              data-layer={position.layer}
              transform={`translate(${position.x}, ${position.y})`}
            >
              <title>{`${node.prompt} (${statusLabel(t, node.state)})`}</title>
              <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx={6} />
              <text x={LABEL_X} y={19} clipPath={`url(#${nodeClipId(clipIdPrefix, runIndex, nodeIndex)})`}>
                {truncate(node.label ?? node.prompt, 13)}
              </text>
              <NodeStatusGlyph state={node.state} />
            </g>,
          ];
        })}
      </svg>
    </div>
  );
}

export function DagSection({ dags, t, view, onViewChange, clipIdPrefix }: {
  readonly dags: readonly ActivityDagRun[];
  readonly t: Translate;
  readonly view: DagView;
  readonly onViewChange: (view: DagView) => void;
  readonly clipIdPrefix: string;
}) {
  return (
    <section className="th-activity-section">
      <div className="th-activity-dag-toolbar">
        <span className="th-activity-section-title">{t("activity.dag")}</span>
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
            <DagGraph run={run} runIndex={runIndex} clipIdPrefix={clipIdPrefix} t={t} />
          ) : (
            <ul className="th-activity-dagnodes">
              {run.nodes.map((node) => (
                <li key={node.id} className="th-activity-dnode">
                  <span className="th-activity-dnode-label" title={node.prompt}>
                    {truncate(node.label ?? node.prompt, 48)}
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
