/** T4 (activity + DAG) scenario probes for the visual-redesign QA harness.
 *
 * Governing sources (binding):
 *   .omo/plans/visual-redesign.md         - scenarios S8/S13/S14 (T4 rows)
 *   .omo/plans/visual-redesign-tokens.md  - token contract v2
 *   DESIGN.md (v2)                        - state encoding, motion, DAG anatomy
 *
 * This module is a per-task scenario plugin (see the contract in
 * visual-redesign.mjs): it exports `scenarios` keyed by scenario id and the
 * CLI merges it over the built-in registry. T4 owns:
 *
 *   S8  - activity-shelf and DAG running indicators (agent-alive violet)
 *         plus reduced-motion collapse with a textual state word. The
 *         transcript tool glyph is T2's: this check excludes it (and anything
 *         in the chat transcript) and records that exclusion. T5 reruns the
 *         built-in full S8 on merged main. DAG motion assertions still extend
 *         the scoped check.
 *   S13 - shelf segmented control: exactly one thumb element whose transform
 *         follows the selected tab, ArrowRight/Home/End roving keys with
 *         focus, Enter toggle, and visible non-mono counts.
 *   S14 - DAG graph + list redesign: no state-coloured node strokes, glyph
 *         left of the label, cubic-bezier <path> edges, animated comet on
 *         the running edge, halo on the running node, run-header progress
 *         fill scaleX == completed/total (+-0.01), auto-scroll of the
 *         running node on the first graph paint, list-view timeline rail,
 *         stable node transforms across state changes, and dense 16/64-node
 *         graphs without node overlap or document overflow.
 *
 * Every probe includes assertions the pre-redesign baseline fails (boxed
 * tabs with mono counts, state-stroked nodes, right-hand glyphs, <line>
 * edges, no thumb/comet/halo/progress/auto-scroll/rail), so a pass is real
 * signal, while behaviour that already exists (roving keys, Enter toggle,
 * stable transforms, node separation) is pinned and must survive the
 * redesign unchanged.
 *
 * DAG REACHABILITY (harness gap this plugin works around): ChatPane always
 * passes a dagSource, so the shelf renders CompleteDagSection, whose catalog
 * (GET /api/workspaces/<ws>/chats/<chat>/dag-runs) and per-run document the
 * built-in fixture does not serve - the shared deliverRunningDag helper can
 * therefore never reach `.th-activity-gnode--running` (it 404s into the
 * catalog error alert). This plugin serves both endpoints through
 * page.route() AFTER setup and BEFORE the DAG tab opens (registration time
 * only matters for requests in flight), and drives state changes through
 * the same WS summary frames the real server pushes.
 *
 * Layout of this module:
 *   1. Stage fixtures (pure): synthetic DAG runs whose wire shape passes the
 *      product's own parsers (parseCompleteDag / parseDagCatalog /
 *      parseDagUpdated - unit-tested against the real TS modules).
 *   2. Pure verdicts over measured facts (unit-tested here, executed by the
 *      drivers): thumb/roving/count-font, edge shape, glyph order, node
 *      strokes, comet/halo, progress scaleX, auto-scroll, rail, overlap,
 *      stable transforms.
 *   3. In-page probes (serialized into the page with pageKit() ahead of
 *      them - they may only reference DOM APIs and kit helpers, never
 *      module imports or closures; the test file enforces this).
 *   4. Driver helpers + the exported `scenarios` object.
 */
import {
  colorEquals,
  parseColor,
} from './visual-redesign-probes.mjs';

// ---------------------------------------------------------------------------
// 1. Stage fixtures (pure)
// ---------------------------------------------------------------------------

/** Delivery order; each delivery bumps a tick so updated_at strictly rises. */
export const T4_STAGE_ORDER = Object.freeze(['mixed', 'mixed-flip', 'dense16', 'dense64']);

export const T4_RUN = Object.freeze({
  id: 't4-dag-run',
  key: 't4-dag',
  name: 'T4 redesign probe DAG',
});

/** Node spec of a stage: id, label, state, deps, and its wave (column). */
export function t4StageSpec(stage) {
  const chain = (count, states) => Array.from({ length: count }, (unused, i) => ({
    id: `k${i}`,
    label: `노드 k${i}`,
    prompt: `T4 probe node k${i}: ${stage} stage verification target with a longer prompt`,
    state: states[i % states.length],
    deps: i === 0 ? [] : [`k${i - 1}`],
    wave: i,
  }));
  if (stage === 'mixed') {
    // 10-node chain: 6 completed, running at column 6 (auto-scroll target),
    // 3 pending. One failed sibling branches off k2 (error glyph coverage).
    const states = ['completed', 'completed', 'completed', 'completed', 'completed', 'completed',
      'running', 'pending', 'pending', 'pending'];
    const nodes = chain(10, states);
    nodes.push({ id: 'f', label: '실패 노드 f', prompt: 'T4 probe node f: failed branch', state: 'failed', deps: ['k2'], wave: 3 });
    return nodes;
  }
  if (stage === 'mixed-flip') {
    // Same topology as mixed; k7 flips pending -> completed so node
    // transforms must stay identical while state treatments change.
    const states = ['completed', 'completed', 'completed', 'completed', 'completed', 'completed',
      'running', 'completed', 'pending', 'pending'];
    const nodes = chain(10, states);
    nodes.push({ id: 'f', label: '실패 노드 f', prompt: 'T4 probe node f: failed branch', state: 'failed', deps: ['k2'], wave: 3 });
    return nodes;
  }
  if (stage === 'dense16') {
    // 4 waves x 4 nodes; wave 0 completed, wave 1 running, rest pending.
    // Each node depends on two nodes of the previous wave (8 edges/pair).
    return denseSpec(4, 4);
  }
  if (stage === 'dense64') {
    // 8 waves x 8 nodes; same state pattern, two deps per node per wave gap.
    return denseSpec(8, 8);
  }
  throw new Error(`unknown T4 stage: ${stage}`);
}

function denseSpec(waves, perWave) {
  const nodes = [];
  for (let wave = 0; wave < waves; wave += 1) {
    const state = wave === 0 ? 'completed' : wave === 1 ? 'running' : 'pending';
    for (let i = 0; i < perWave; i += 1) {
      nodes.push({
        id: `w${wave}n${i}`,
        label: `w${wave}n${i}`,
        prompt: `T4 dense node w${wave}n${i}`,
        state,
        deps: wave === 0 ? [] : [`w${wave - 1}n${i}`, `w${wave - 1}n${(i + Math.floor(perWave / 2) - 1) % perWave}`],
        wave,
      });
    }
  }
  return nodes;
}

/** Exact state histogram (the complete-doc parser recomputes and requires
 * equality, including `total`). */
export function t4RunCounts(spec) {
  const counts = { total: spec.length, pending: 0, blocked: 0, scheduled: 0, running: 0, completed: 0, failed: 0, cancelled: 0, skipped: 0 };
  for (const node of spec) {
    if (!(node.state in counts)) throw new Error(`unknown node state ${node.state}`);
    counts[node.state] += 1;
  }
  return counts;
}

/** Full wire run for a stage at a delivery tick (tick keeps revisions
 * strictly increasing across successive deliveries). */
export function t4StageRun(stage, tick = 0) {
  const spec = t4StageSpec(stage);
  const nodes = spec.map(node => ({
    id: node.id, prompt: node.prompt, state: node.state, label: node.label,
    depends_on: node.deps.slice(), attempt: 1,
  }));
  const edges = spec.flatMap(node => node.deps.map(dep => ({ from: dep, to: node.id })));
  const byWave = new Map();
  for (const node of spec) {
    if (!byWave.has(node.wave)) byWave.set(node.wave, []);
    byWave.get(node.wave).push(node.id);
  }
  const waves = [...byWave.entries()].sort((a, b) => a[0] - b[0])
    .map(([index, nodeIds]) => ({ index, node_ids: nodeIds.slice() }));
  const at = index => new Date(Date.parse('2026-09-26T09:00:00.000Z') + index * 60_000).toISOString();
  return {
    run_id: T4_RUN.id, run_key: T4_RUN.key, name: `${T4_RUN.name} - ${stage}`,
    status: 'running', created_at: at(0), updated_at: at(1 + tick),
    counts: t4RunCounts(spec), nodes, edges, waves,
  };
}

/** GET ?limit=... catalog payload for the run of a stage. */
export function t4CatalogPayload(run) {
  return { runs: [{ run_id: run.run_id, run_key: run.run_key, name: run.name, status: run.status, total: run.counts.total, content_token: `t4-${run.updated_at}` }], next_cursor: null };
}

/** GET /{runId} complete-document payload. */
export function t4DocumentPayload(run) {
  return { complete: true, content_token: `t4-${run.updated_at}`, run };
}

/** Chat-socket delivery: the product consumes activity snapshots as
 * `extensionEvent` frames ({type, sessionId, name, data}) - one per
 * snapshot (useChatFrameHandler's extensionEvent case). A sessions.activity
 * frame is ONLY parsed by the overview socket, so stage updates delivered
 * in that shape on the chat socket are silently ignored (found live: the
 * dense-stage transitions never re-rendered). */
export function t4ExtensionFrames(run, chat) {
  const task = { parent_session_id: chat, truncated_tasks: false,
    tasks: [{ task_id: 't4-marker', name: 'T4 marker', status: 'pending', updated_at: run.updated_at,
      live_progress: { last_assistant_line: `t4-${run.counts.total}-nodes` } }] };
  const dag = { parent_session_id: chat, truncated_runs: false,
    run_running_count: run.counts.running > 0 ? 1 : 0, run_total_count: 1, runs: [run] };
  return [
    { type: 'extensionEvent', sessionId: chat, name: 'omo.task.updated', data: task },
    { type: 'extensionEvent', sessionId: chat, name: 'omo.dag.updated', data: dag },
  ];
}

/** Overview-socket frame (all_live subscribers / sidebar tree): the
 * sessions.activity shape useLiveSessions parses. */
export function t4ActivityFrame(run, chat) {
  const [, dag] = t4ExtensionFrames(run, chat);
  return { type: 'sessions.activity', sessionId: chat, durableSessionId: chat, overflow: false,
    snapshots: [
      { name: 'omo.task.updated', data: null, oversized: false },
      { name: 'omo.dag.updated', data: dag.data, oversized: false },
    ] };
}

/** Finished (succeeded + failed + skipped) / total, from run-document counts. */
export function t4ExpectedProgress(stage) {
  const counts = t4RunCounts(t4StageSpec(stage));
  return (counts.completed + counts.failed + counts.skipped) / counts.total;
}

/** Node ids by role for a stage (probe arguments). */
export function t4StageRoles(stage) {
  const spec = t4StageSpec(stage);
  const ids = role => spec.filter(node => node.state === role).map(node => node.id);
  return { running: ids('running'), completed: ids('completed'), failed: ids('failed') };
}

// ---------------------------------------------------------------------------
// 2. Pure verdicts over measured facts
// ---------------------------------------------------------------------------

/** First family name of a computed font-family, normalized. */
export function firstFamily(fontFamily) {
  const first = String(fontFamily ?? '').split(',')[0]?.trim() ?? '';
  return first.replace(/^["']|["']$/g, '').toLowerCase();
}

/** scaleX of a computed transform: matrix(a,b,c,d,e,f) -> hypot(a,b);
 * matrix3d uses the first column pair. `none` -> null. */
export function scaleXFromTransform(transform) {
  const text = String(transform ?? '').trim();
  if (!text || text === 'none') return null;
  const inline = /^scaleX\(([^)]+)\)$/.exec(text);
  if (inline) {
    const value = Number(inline[1]);
    return Number.isFinite(value) ? value : null;
  }
  let m = /^matrix\(([^)]+)\)$/.exec(text);
  if (m) {
    const values = m[1].split(',').map(v => parseFloat(v));
    if (values.length < 4 || values.some(v => !Number.isFinite(v))) return null;
    return Math.hypot(values[0], values[1]);
  }
  m = /^matrix3d\(([^)]+)\)$/.exec(text);
  if (m) {
    const values = m[1].split(',').map(v => parseFloat(v));
    if (values.length < 8 || values.some(v => !Number.isFinite(v))) return null;
    return Math.hypot(values[0], values[1]);
  }
  return null;
}

/** S14: every run-header fill's settled scale and inline target must both
 * equal finished/total (+-0.01). */
export function progressVerdict(progressFacts, expected) {
  const failures = [];
  const candidates = (progressFacts ?? []).filter(fact => fact && fact.found);
  if (candidates.length === 0) {
    return { pass: false, failures: ['run header has no progress fill'], measured: null, expected };
  }
  for (const fact of candidates) {
    if (!fact.settled) failures.push(`progress fill did not settle at ${fact.where}`);
    if (fact.scaleX === null || fact.scaleX === undefined) failures.push(`progress fill has no computed scaleX at ${fact.where}`);
    else if (Math.abs(fact.scaleX - expected) > 0.01 + 1e-9) {
      failures.push(`progress fill scaleX ${fact.scaleX.toFixed(4)} != completed/total ${expected.toFixed(4)} (at ${fact.where})`);
    }
    if (fact.inlineScaleX === null || fact.inlineScaleX === undefined) failures.push(`progress fill has no inline scaleX target at ${fact.where}`);
    else if (Math.abs(fact.inlineScaleX - expected) > 0.01 + 1e-9) {
      failures.push(`progress fill inline scaleX ${fact.inlineScaleX.toFixed(4)} != completed/total ${expected.toFixed(4)} (at ${fact.where})`);
    }
  }
  return { pass: failures.length === 0, failures, measured: candidates[0].scaleX ?? null, expected };
}

/** S14: every graph edge (outside defs/marker) is a <path> with a cubic 'C'
 * command. Baseline <line> edges fail. */
export function edgeShapeVerdict(edgeFacts) {
  const failures = [];
  const edges = (edgeFacts ?? []).filter(fact => fact && !fact.inDefs);
  if (edges.length === 0) {
    failures.push('no graph edges found in the DAG svg');
    return { pass: false, failures, measured: { edgeCount: 0 } };
  }
  const notPath = edges.filter(fact => fact.tag !== 'path');
  const noC = edges.filter(fact => fact.tag === 'path' && !/C/i.test(fact.d ?? ''));
  if (notPath.length > 0) failures.push(`${notPath.length}/${edges.length} edges are <${notPath[0].tag}>, not <path> with bezier C commands`);
  if (noC.length > 0) failures.push(`${noC.length}/${edges.length} <path> edges carry no 'C' (cubic bezier) command in d`);
  return { pass: failures.length === 0, failures, measured: { edgeCount: edges.length, straight: notPath.length + noC.length } };
}

/** S14: the status glyph sits strictly left of the node label.
 * nodeFacts glyphs/labels come either flat ({left,width} - unit fixtures)
 * or as the probe's {rect:{left,...}} boxes; both shapes are accepted. */
export function glyphOrderVerdict(nodeFacts) {
  const failures = [];
  const boxLeft = box => (box && box.rect ? box.rect.left : box ? box.left : undefined);
  const boxWidth = box => (box && box.rect ? box.rect.width : box ? box.width : undefined);
  const judged = (nodeFacts ?? []).filter(fact => fact && fact.glyph && fact.label
    && boxLeft(fact.glyph) !== undefined && boxLeft(fact.label) !== undefined);
  if (judged.length === 0) {
    failures.push('no graph node exposes both a status glyph and a label to judge glyph order');
    return { pass: false, failures, measured: { judged: 0 } };
  }
  const wrong = judged.filter(fact => boxLeft(fact.glyph) + Math.min(boxWidth(fact.glyph) ?? 0, 2) > boxLeft(fact.label) + 1);
  if (wrong.length > 0) failures.push(`${wrong.length}/${judged.length} nodes carry the status glyph at or right of the label (first: ${wrong[0].id})`);
  return { pass: failures.length === 0, failures, measured: { judged: judged.length, wrongOrder: wrong.length } };
}

/** S14: node card strokes never equal a state/accent token colour.
 * nodeFacts: [{id, stroke}]; tokens: raw token strings, parsed here. */
export function nodeStrokeViolations(nodeFacts, tokens) {
  const wanted = Object.entries(tokens ?? {})
    .map(([name, raw]) => ({ name, color: parseColor(raw) }))
    .filter(entry => entry.color !== null);
  const violations = [];
  for (const fact of nodeFacts ?? []) {
    const stroke = parseColor(fact.stroke);
    if (!stroke || stroke.a < 0.02) continue;
    for (const token of wanted) {
      if (colorEquals(stroke, token.color) && violations.length < 60) {
        violations.push({ id: fact.id, token: token.name, stroke: fact.stroke });
      }
    }
  }
  const failures = violations.length > 0
    ? [`${violations.length} node card strokes encode state by colour (first: ${violations[0].id} -> ${violations[0].token} ${violations[0].stroke})`]
    : [];
  return { pass: failures.length === 0, failures, violations };
}

/** Geometric match of the edge whose endpoints connect `fromRect`
 * (completed node) and `toRect` (running node). Symmetric in argument order:
 * each endpoint must fall inside its node's box (inflated by the tolerance)
 * so the matcher never depends on which box side an implementation
 * happens to attach its bezier to. Pure part of comet anchoring. */
export function findRunningEdge(edgeFacts, fromRect, toRect, tolerance = 60) {
  if (!fromRect || !toRect) return null;
  const near = (point, rect) => !!point
    && point.x >= rect.left - tolerance && point.x <= rect.right + tolerance
    && point.y >= rect.top - tolerance && point.y <= rect.bottom + tolerance;
  for (const fact of edgeFacts ?? []) {
    if (!fact || fact.inDefs) continue;
    if ((near(fact.p0, fromRect) && near(fact.p1, toRect))
      || (near(fact.p0, toRect) && near(fact.p1, fromRect))) return fact;
  }
  return null;
}

function rectsIntersect(a, b, inflate = 0) {
  if (!a || !b) return false;
  return a.left - inflate < b.right && b.left < a.right + inflate
    && a.top - inflate < b.bottom && b.top < a.bottom + inflate;
}

/** S14: a comet element exists, animates, and rides the running edge. */
export function cometVerdict(cometFacts, runningEdge) {
  const failures = [];
  const comets = (cometFacts ?? []).filter(fact => fact && fact.found);
  if (comets.length === 0) {
    return { pass: false, failures: ['no comet element (class/data ~ "comet") exists in the graph while an edge flows completed -> running'], measured: { comets: 0 } };
  }
  const animated = comets.filter(fact => (fact.runningAnimations ?? 0) > 0);
  if (animated.length === 0) failures.push(`${comets.length} comet element(s) found but none carries a running animation`);
  if (!runningEdge) {
    failures.push('could not identify the running edge geometrically (completed -> running node)');
    return { pass: false, failures, measured: { comets: comets.length, animated: 0 } };
  }
  const riding = animated.filter(fact => rectsIntersect(fact.rect, runningEdge.rect, 12));
  if (riding.length === 0 && animated.length > 0) failures.push(`animated comet does not intersect the running edge's bounding box (edge at ${JSON.stringify(runningEdge.rect)})`);
  return { pass: failures.length === 0, failures, measured: { comets: comets.length, animated: animated.length, riding: riding.length } };
}

/** S14: the running node carries a visible halo element (in-group or
 * overlapping the node box). */
export function haloVerdict(haloFacts, runningNodeRect) {
  const failures = [];
  const halos = (haloFacts ?? []).filter(fact => fact && fact.found);
  if (halos.length === 0) {
    return { pass: false, failures: ['running node has no halo element (class/data ~ "halo")'], measured: { halos: 0 } };
  }
  const visible = halos.filter(fact => (fact.rect?.width ?? 0) > 1 && (fact.rect?.height ?? 0) > 1);
  if (visible.length === 0) failures.push('halo element(s) found but none is visibly sized');
  const onNode = visible.filter(fact => fact.insideRunningNode || rectsIntersect(fact.rect, runningNodeRect, 4));
  if (onNode.length === 0 && visible.length > 0) failures.push('no visible halo intersects the running node box');
  return { pass: failures.length === 0, failures, measured: { halos: halos.length, visible: visible.length, onNode: onNode.length } };
}

/** S14: on the first graph paint the graph reel scrolls the running node
 * into view. scrollFacts: {scroller, runningRect, overflow}. */
export function autoScrollVerdict(scrollFacts) {
  const failures = [];
  if (!scrollFacts || !scrollFacts.scroller) {
    return { pass: false, failures: ['graph reel scroller (overflow-x owner) not found around the running node'], measured: null };
  }
  const { scroller, runningRect } = scrollFacts;
  if (scroller.scrollWidth <= scroller.clientWidth + 1) {
    // No horizontal overflow in this fixture cell: nothing to auto-scroll.
    return { pass: true, failures, measured: { skipped: 'no horizontal overflow', ...scroller } };
  }
  if (scroller.scrollLeft <= 0) failures.push(`graph content overflows (${scroller.scrollWidth}>${scroller.clientWidth}px) but scrollLeft stayed ${scroller.scrollLeft}: running node not scrolled into view on first paint`);
  const center = (runningRect.left + runningRect.right) / 2;
  if (center < scroller.rect.left - 1 || center > scroller.rect.right + 1) {
    failures.push(`running node center ${center.toFixed(1)} outside the visible reel ${scroller.rect.left.toFixed(1)}..${scroller.rect.right.toFixed(1)}`);
  }
  return { pass: failures.length === 0, failures, measured: scroller };
}

/** S14: list view rows render as timeline items with a rail. */
export function railVerdict(rowFacts) {
  const failures = [];
  const rows = rowFacts ?? [];
  if (rows.length === 0) {
    failures.push('list view rendered no node rows');
    return { pass: false, failures, measured: { rows: 0 } };
  }
  const railed = rows.filter(fact => fact.railChild || fact.pseudoRail || fact.ruleChild);
  if (railed.length < rows.length) {
    failures.push(`${rows.length - railed.length}/${rows.length} list rows have no timeline rail (child ~rail, pseudo-element, or narrow rule)`);
  }
  return { pass: failures.length === 0, failures, measured: { rows: rows.length, railed: railed.length } };
}

/** S14: dense graphs never overlap node boxes (1px² tolerance). */
export function overlapVerdict(nodeRects) {
  const failures = [];
  const rects = nodeRects ?? [];
  const overlapping = [];
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i].rect, b = rects[j].rect;
      const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (width > 1 && height > 1 && overlapping.length < 20) overlapping.push({ a: rects[i].id, b: rects[j].id, width: +width.toFixed(1), height: +height.toFixed(1) });
    }
  }
  if (overlapping.length > 0) failures.push(`${overlapping.length} node pairs overlap (first: ${overlapping[0].a} vs ${overlapping[0].b} ${overlapping[0].width}x${overlapping[0].height}px)`);
  return { pass: failures.length === 0, failures, overlapping };
}

/** S14 stable-layout pin: the outer transform attribute of every node is
 * unchanged when only node states change. */
export function stableTransformVerdict(before, after) {
  const failures = [];
  const beforeById = new Map((before ?? []).map(fact => [fact.id, fact.transform]));
  if ((before ?? []).length === 0 || (after ?? []).length === 0) {
    failures.push('stable-layout capture missing node transforms');
    return { pass: false, failures, measured: { before: (before ?? []).length, after: (after ?? []).length } };
  }
  for (const fact of after) {
    if (!beforeById.has(fact.id)) {
      failures.push(`node ${fact.id} appeared during a state-only change`);
      continue;
    }
    if (beforeById.get(fact.id) !== fact.transform) {
      failures.push(`node ${fact.id} transform changed on a state-only update: ${beforeById.get(fact.id)} -> ${fact.transform}`);
    }
  }
  return { pass: failures.length === 0, failures, measured: { nodes: after.length } };
}

/** S13: exactly one thumb; its transform changes when the selection moves
 * and it stays aligned with the selected tab.
 * facts: {thumb: {found, transform, rect}|null, selectedId, tabs: [{id, rect}]}. */
export function thumbVerdict(before, after) {
  const failures = [];
  const measure = facts => facts?.thumb;
  if (!measure(before)?.found || !measure(after)?.found) {
    return { pass: false, failures: ['segmented control has no single thumb element (class/data ~ "thumb" or non-tab tablist child)'], measured: null };
  }
  if (String(before.thumb.transform) === String(after.thumb.transform)) {
    failures.push(`thumb transform did not change between selections (stayed ${before.thumb.transform})`);
  }
  for (const [label, facts] of [['before', before], ['after', after]]) {
    const tab = (facts.tabs ?? []).find(candidate => candidate.id === facts.selectedId);
    if (!tab) {
      failures.push(`${label}: selected tab ${facts.selectedId} not found in tab facts`);
      continue;
    }
    const thumbCenter = (facts.thumb.rect.left + facts.thumb.rect.right) / 2;
    if (thumbCenter < tab.rect.left - 3 || thumbCenter > tab.rect.right + 3) {
      failures.push(`${label}: thumb center ${thumbCenter.toFixed(1)} not aligned with selected tab ${tab.id} (${tab.rect.left.toFixed(1)}..${tab.rect.right.toFixed(1)})`);
    }
  }
  return {
    pass: failures.length === 0, failures,
    measured: { beforeTransform: before.thumb.transform, afterTransform: after.thumb.transform },
  };
}

/** S13: roving keyboard steps moved selection AND focus, tabindice follow.
 * steps: [{key, expected, selected, active, rovingOk}]. */
export function rovingVerdict(steps) {
  const failures = [];
  const judged = steps ?? [];
  if (judged.length === 0) {
    failures.push('no roving keyboard steps were measured');
    return { pass: false, failures };
  }
  for (const step of judged) {
    if (step.selected !== step.expected) failures.push(`${step.key}: selection moved to ${step.selected}, expected ${step.expected}`);
    if (step.active !== step.expected) failures.push(`${step.key}: focus moved to ${step.active}, expected ${step.expected}`);
    if (step.rovingOk !== true) failures.push(`${step.key}: roving tabindex not on ${step.expected} (selected tab must be the only tabIndex=0 tab)`);
  }
  return { pass: failures.length === 0, failures };
}

/** S13: counts are visible and never mono. tabFacts: [{id, count: {text,
 * family, visible}|null}]; monoFirstFamily comes from --th-font-mono. */
export function countFontVerdict(tabFacts, monoFirstFamily) {
  const failures = [];
  const withCounts = (tabFacts ?? []).filter(fact => fact.count && fact.count.text);
  if (withCounts.length === 0) {
    failures.push('no shelf tab carries a visible count');
    return { pass: false, failures, measured: { counts: 0 } };
  }
  const mono = [];
  for (const fact of withCounts) {
    if (fact.count.visible !== true) failures.push(`tab ${fact.id} count "${fact.count.text}" is not visibly rendered`);
    const family = firstFamily(fact.count.family);
    const isMono = /mono|jetbrains|menlo|consolas|courier/i.test(fact.count.family ?? '') || (monoFirstFamily && family === monoFirstFamily);
    if (isMono) mono.push({ id: fact.id, family: fact.count.family });
  }
  if (mono.length > 0) failures.push(`${mono.length} tab count(s) render in the mono stack (first: ${mono[0].id} ${mono[0].family})`);
  return { pass: failures.length === 0, failures, measured: { counts: withCounts.length, mono: mono.length } };
}

/** S8: under normal motion the running DAG glyph animates (progress motion
 * is honest); facts from probeDagRunningMotion. */
export function dagRunningMotionVerdict(facts) {
  const failures = [];
  const glyphs = (facts?.runningGlyphs ?? []).filter(g => g.found);
  if (glyphs.length === 0) {
    failures.push('no running DAG status glyph found in the graph');
    return { pass: false, failures };
  }
  const animated = glyphs.filter(g => (g.runningAnimations ?? 0) > 0);
  if (animated.length === 0) failures.push(`${glyphs.length} running DAG glyph(s) carry no running animation under normal motion`);
  return { pass: failures.length === 0, failures, measured: { glyphs: glyphs.length, animated: animated.length } };
}

/** S8: running glyph stroke/colour equals the accent token (violet,
 * agent-alive); redundant textual state also recorded. */
export function dagGlyphAccentVerdict(facts, accentRaw) {
  const failures = [];
  const accent = parseColor(accentRaw);
  const glyphs = (facts?.runningGlyphs ?? []).filter(g => g.found);
  if (!accent) {
    failures.push(`--th-accent unresolved (${accentRaw})`);
    return { pass: false, failures };
  }
  if (glyphs.length === 0) {
    failures.push('no running DAG status glyph found for the accent check');
    return { pass: false, failures };
  }
  for (const glyph of glyphs) {
    const candidates = [glyph.stroke, glyph.color, glyph.border, glyph.background, glyph.fill]
      .map(raw => parseColor(raw)).filter(color => color && color.a > 0.02);
    if (candidates.length === 0) {
      failures.push(`running DAG glyph at ${glyph.where} paints no colour to compare (stroke ${glyph.stroke}, color ${glyph.color})`);
      continue;
    }
    if (!candidates.some(color => colorEquals(color, accent))) {
      failures.push(`running DAG glyph at ${glyph.where} is not accent-coloured (stroke ${glyph.stroke}, color ${glyph.color}, background ${glyph.background})`);
    }
  }
  return { pass: failures.length === 0, failures, measured: { glyphs: glyphs.length, accent: accentRaw } };
}

/** S8: under prefers-reduced-motion nothing on the running indicator
 * animates and the localized state word is present as visible text. */
export function dagReducedMotionVerdict(facts, runningWordPattern = /(running|실행|진행)/i) {
  const failures = [];
  const animatedParts = [];
  for (const glyph of facts?.runningGlyphs ?? []) {
    if (glyph.found && (glyph.runningAnimations ?? 0) > 0) animatedParts.push(`glyph@${glyph.where}`);
  }
  for (const comet of facts?.comets ?? []) {
    if (comet.found && (comet.runningAnimations ?? 0) > 0) animatedParts.push(`comet@${comet.where}`);
  }
  for (const halo of facts?.halos ?? []) {
    if (halo.found && (halo.runningAnimations ?? 0) > 0) animatedParts.push(`halo@${halo.where}`);
  }
  if (animatedParts.length > 0) failures.push(`${animatedParts.length} running-indicator part(s) still animate under reduced motion: ${animatedParts.slice(0, 4).join(', ')}`);
  const words = (facts?.stateWords ?? []).filter(word => word.visible && runningWordPattern.test(word.text ?? ''));
  if (words.length === 0) {
    failures.push(`no visible textual running state on the running node under reduced motion (state words: ${JSON.stringify((facts?.stateWords ?? []).map(w => w.text))})`);
  }
  return { pass: failures.length === 0, failures, measured: { stateWords: facts?.stateWords ?? [], animatedParts } };
}

// ---------------------------------------------------------------------------
// 3. In-page probes. Serialized with pageKit() in scope: they may use only
//    DOM APIs and kit helpers (parseColor/colorEquals/describeElement/
//    isVisibleElement/collectAnimations/tokenColor), never module names.
//    Small helpers (rectJson/animJson) are inlined per probe because only
//    ONE function source is injected per evaluation.
// ---------------------------------------------------------------------------

/** S14 core: DAG graph facts. arg: {runningId, sourceId}. */
export async function probeDagGraph(arg) {
  const svg = document.querySelector('.th-activity-graph svg')
    ?? document.querySelector('[data-activity-tabpanel="dag"] svg');
  if (!svg) return { found: false, reason: 'no DAG graph svg rendered' };
  const fills = [...document.querySelectorAll('.th-activity-dag-head .th-activity-dag-progress-fill')];
  const animations = fills.flatMap(fill => fill.getAnimations().filter(animation => animation.playState === 'running'));
  let settled = true;
  if (animations.length > 0) {
    let timer;
    try {
      settled = await Promise.race([
        Promise.allSettled(animations.map(animation => animation.finished)).then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 1600); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const root = getComputedStyle(document.documentElement);
  const tokens = {};
  for (const name of ['--th-success', '--th-warning', '--th-error', '--th-accent']) tokens[name] = root.getPropertyValue(name).trim();
  const rectJson = element => { const r = element.getBoundingClientRect();
    return { left: +r.left.toFixed(2), top: +r.top.toFixed(2), right: +r.right.toFixed(2), bottom: +r.bottom.toFixed(2), width: +r.width.toFixed(2), height: +r.height.toFixed(2) }; };
  const animJson = element => collectAnimations(element).map(a => ({ kind: a.kind, name: a.name, playState: a.playState, iterations: a.iterations }));
  const nodeGroups = [...svg.querySelectorAll('g[class*="gnode"], g[data-node]')];
  const seen = new Set();
  const nodes = [];
  for (const group of nodeGroups) {
    const id = group.getAttribute('data-node') ?? `node-${nodes.length}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const card = group.querySelector('rect');
    const cardStyle = card ? getComputedStyle(card) : null;
    const glyph = group.querySelector('[class*="gstatus" i], [class*="glyph" i], [data-glyph]');
    const label = group.querySelector('text[class*="glabel" i], text.label');
    const stateText = group.querySelector('text[class*="gstate" i], [data-state-word]');
    nodes.push({
      id, cls: group.getAttribute('class'), transform: group.getAttribute('transform'),
      rect: rectJson(group),
      stroke: cardStyle ? cardStyle.stroke : null, strokeWidth: cardStyle ? cardStyle.strokeWidth : null,
      glyph: glyph ? { found: true, tag: glyph.tagName, rect: rectJson(glyph) } : { found: false },
      label: label ? { found: true, rect: rectJson(label), text: (label.textContent || '').slice(0, 24) } : { found: false },
      stateWord: stateText ? { text: (stateText.textContent || '').trim(), visible: isVisibleElement(stateText) } : null,
    });
  }
  const svgRect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : null;
  const scale = viewBox && viewBox.width ? svgRect.width / viewBox.width : 1;
  const pointJson = (element, atEnd) => {
    try {
      if (typeof element.getTotalLength !== 'function') return null;
      const point = element.getPointAtLength(atEnd ? element.getTotalLength() : 0);
      return { x: +(svgRect.left + point.x * scale).toFixed(2), y: +(svgRect.top + point.y * scale).toFixed(2) };
    } catch (error) { return null; }
  };
  const edges = [];
  for (const element of svg.querySelectorAll('[class*="gedge" i]')) {
    const inDefs = !!(element.closest && element.closest('marker, defs'));
    edges.push({
      tag: element.tagName.toLowerCase(), d: element.getAttribute('d'), cls: element.getAttribute('class'),
      inDefs, rect: rectJson(element), p0: pointJson(element, false), p1: pointJson(element, true),
    });
  }
  const runningElement = svg.querySelector(`[data-node="${arg.runningId}"]`);
  const comets = [], halos = [];
  for (const element of svg.querySelectorAll('[class*="comet" i], [data-comet]')) {
    comets.push({ found: true, where: describeElement(element), rect: rectJson(element), runningAnimations: animJson(element).filter(a => a.playState === 'running').length, animations: animJson(element) });
  }
  for (const element of svg.querySelectorAll('[class*="halo" i], [data-halo]')) {
    halos.push({
      found: true, where: describeElement(element), rect: rectJson(element),
      insideRunningNode: !!(runningElement && runningElement.contains(element)),
      runningAnimations: animJson(element).filter(a => a.playState === 'running').length, animations: animJson(element),
    });
  }
  const progress = fills.filter(isVisibleElement).map(fill => ({
    found: true, where: describeElement(fill),
    transform: getComputedStyle(fill).transform,
    inlineTransform: fill.style.transform,
    settled: settled && fill.getAnimations().every(animation => animation.playState !== 'running'),
    rect: rectJson(fill),
  }));
  let scroller = null;
  if (runningElement) {
    for (let node = runningElement.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/auto|scroll|hidden/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1) {
        scroller = { where: describeElement(node), cls: node.getAttribute('class'), scrollLeft: node.scrollLeft, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, rect: rectJson(node) };
        break;
      }
    }
  }
  return {
    found: true, tokens, nodes, edges, comets, halos, progress,
    runningRect: runningElement ? rectJson(runningElement) : null,
    scroller,
    document: { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth },
  };
}

/** S14: list-view row facts. */
export function probeDagList() {
  const panel = document.querySelector('[data-activity-tabpanel="dag"]');
  if (!panel) return { found: false, reason: 'DAG tabpanel not rendered' };
  const rows = [...panel.querySelectorAll('.th-activity-dagnodes > li, ul[class*="dag" i] > li, [class*="timeline" i] [class*="item" i], [class*="timeline" i] > li')];
  const rectJson = element => { const r = element.getBoundingClientRect();
    return { left: +r.left.toFixed(2), top: +r.top.toFixed(2), right: +r.right.toFixed(2), bottom: +r.bottom.toFixed(2), width: +r.width.toFixed(2), height: +r.height.toFixed(2) }; };
  const facts = [];
  for (const row of rows.slice(0, 80)) {
    const style = getComputedStyle(row);
    const before = getComputedStyle(row, '::before').content;
    const after = getComputedStyle(row, '::after').content;
    let ruleChild = false;
    for (const child of row.children) {
      const childStyle = getComputedStyle(child);
      const bg = parseColor(childStyle.backgroundColor);
      if (parseFloat(childStyle.width) <= 4 && child.getBoundingClientRect().height >= row.getBoundingClientRect().height * 0.4 && bg && bg.a > 0.02) { ruleChild = true; break; }
    }
    facts.push({
      cls: row.getAttribute('class'), rect: rectJson(row), text: (row.textContent || '').trim().slice(0, 32),
      railChild: !!row.querySelector('[class*="rail" i], [data-rail]'),
      pseudoRail: (before && before !== 'none') || (after && after !== 'none'),
      ruleChild,
    });
  }
  return { found: true, rows: facts, viewMode: !!panel.querySelector('.th-activity-graph, svg') ? 'graph' : 'list' };
}

/** S13: shelf tab strip facts (tabs, counts, single thumb). */
export function probeShelfTabs() {
  const tablist = document.querySelector('.th-activity-tabs')
    ?? document.querySelector('[role="tablist"][class*="activity" i]');
  if (!tablist) return { found: false, reason: 'activity tablist not rendered' };
  const rectJson = element => { const r = element.getBoundingClientRect();
    return { left: +r.left.toFixed(2), top: +r.top.toFixed(2), right: +r.right.toFixed(2), bottom: +r.bottom.toFixed(2), width: +r.width.toFixed(2), height: +r.height.toFixed(2) }; };
  const tabs = [...tablist.querySelectorAll('[role="tab"]')].map(tab => {
    let count = null;
    const countElement = tab.querySelector('[class*="count" i]')
      ?? [...tab.children].find(child => child.children.length === 0 && /^\s*[\d.,]+\s*(\/\s*[\d.,]+\s*)?$/.test(child.textContent ?? ''));
    if (countElement) {
      const countStyle = getComputedStyle(countElement);
      count = {
        where: describeElement(countElement), text: (countElement.textContent || '').trim(),
        family: countStyle.fontFamily, visible: isVisibleElement(countElement),
      };
    }
    return {
      id: tab.getAttribute('data-activity-tab'), rect: rectJson(tab),
      selected: tab.getAttribute('aria-selected') === 'true',
      tabIndex: tab.tabIndex, count,
    };
  });
  const named = tablist.querySelector('[class*="thumb" i], [data-thumb], [data-segment-thumb]');
  const structural = [...tablist.children].find(child => !child.matches('[role="tab"], template, script, style'));
  const thumbElement = named ?? structural ?? null;
  const thumb = thumbElement ? {
    found: true, where: describeElement(thumbElement), source: named ? 'named' : 'structural',
    transform: getComputedStyle(thumbElement).transform, rect: rectJson(thumbElement),
  } : { found: false };
  return {
    found: true, tabs, thumb,
    selectedId: (tabs.find(tab => tab.selected) ?? {}).id ?? null,
    open: document.querySelector('.th-activity-shelf')?.getAttribute('data-open') ?? null,
    monoToken: getComputedStyle(document.documentElement).getPropertyValue('--th-font-mono').trim(),
    sansToken: getComputedStyle(document.documentElement).getPropertyValue('--th-font-sans').trim(),
  };
}

/** S8: running-indicator motion/colour facts for the DAG surface. */
export function probeDagRunningMotion() {
  const animJson = element => collectAnimations(element).map(a => ({ kind: a.kind, name: a.name, playState: a.playState, iterations: a.iterations }));
  const root = getComputedStyle(document.documentElement);
  const accent = root.getPropertyValue('--th-accent').trim();
  const runningGlyphs = [];
  for (const element of document.querySelectorAll('.th-activity-gstatus--running, [class*="gstatus" i][class*="running" i], [data-glyph-state="running"]')) {
    if (!isVisibleElement(element)) continue;
    const style = getComputedStyle(element);
    runningGlyphs.push({
      found: true, where: describeElement(element),
      stroke: style.stroke, color: style.color, fill: style.fill,
      border: style.borderTopColor, background: style.backgroundColor,
      runningAnimations: animJson(element).filter(a => a.playState === 'running').length,
      animations: animJson(element),
    });
  }
  const scope = document.querySelector('.th-activity-graph, [data-activity-tabpanel="dag"]') ?? document;
  const comets = [], halos = [];
  for (const element of scope.querySelectorAll('[class*="comet" i], [data-comet]')) {
    comets.push({ found: true, where: describeElement(element), runningAnimations: animJson(element).filter(a => a.playState === 'running').length });
  }
  for (const element of scope.querySelectorAll('[class*="halo" i], [data-halo]')) {
    halos.push({ found: true, where: describeElement(element), runningAnimations: animJson(element).filter(a => a.playState === 'running').length });
  }
  const stateWords = [];
  for (const group of document.querySelectorAll('g[class*="gnode--running" i], g[data-state="running"], [data-node-state="running"]')) {
    const stateText = group.querySelector('text[class*="gstate" i], [data-state-word]');
    if (stateText) stateWords.push({ node: group.getAttribute('data-node'), text: (stateText.textContent || '').trim(), visible: isVisibleElement(stateText) });
  }
  return { accent, runningGlyphs, comets, halos, stateWords };
}


/** T4 S8. Walks the shared running-glyph census (so a transcript tool glyph
 * is counted, not silently dropped) and judges only indicators inside
 * .th-activity-shelf or the DAG graph/list: .th-activity-g* nodes and
 * glyphs, the run header's live progress fill, list-row glyphs, and the
 * shelf lane glyph. .th-tool-glyph and anything inside .th-chat-transcript
 * are excluded. arg.phase 'reduced' checks that in-scope indicators are
 * still and a textual running label exists; the default phase checks accent.
 * Kit-only: pageKit() injects the helpers this body calls. */
export function probeT4RunningIndicators(arg) {
  const reduced = !!(arg && arg.phase === 'reduced');
  const accent = tokenColor('--th-accent');
  const selectors = runningGlyphSelectors().concat([
    '.th-activity-glyph--running',
    '.th-activity-dag-progress[data-live="true"] .th-activity-dag-progress-fill',
  ]);
  const seen = new Set();
  const excludedCounts = {};
  const excluded = [];
  const inScope = [];
  const failures = [];
  const noteExcluded = selector => {
    excludedCounts[selector] = (excludedCounts[selector] || 0) + 1;
  };
  const regionOf = element => {
    const className = element.getAttribute('class') || '';
    const tool = element.matches('.th-tool-glyph, .th-tool-glyph--running') || element.closest('.th-tool-glyph') !== null;
    const transcript = element.closest('.th-chat-transcript') !== null;
    const shelf = element.closest('.th-activity-shelf') !== null;
    const dag = /(?:^|\s)th-activity-g[\w-]*/.test(className)
      || element.closest('.th-activity-graph, .th-activity-dagnodes, .th-activity-dag-head, .th-activity-dnode, [data-activity-tabpanel="dag"]') !== null;
    return { inScope: (shelf || dag) && !tool && !transcript, tool, transcript };
  };
  if (!accent) failures.push(`--th-accent unresolved`);
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (seen.has(element) || !isVisibleElement(element)) continue;
      seen.add(element);
      const scope = regionOf(element);
      if (!scope.inScope) {
        noteExcluded(selector);
        if (scope.tool) noteExcluded('.th-tool-glyph');
        if (scope.transcript) noteExcluded('.th-chat-transcript');
        if (excluded.length < 20) excluded.push({ selector, where: describeElement(element), tool: scope.tool, transcript: scope.transcript });
        continue;
      }
      const style = getComputedStyle(element);
      const colourFacts = {
        stroke: style.stroke && style.stroke !== 'none' ? hexOf(parseColor(style.stroke)) : null,
        border: hexOf(parseColor(style.borderTopColor)),
        background: hexOf(parseColor(style.backgroundColor)),
        fill: style.fill && style.fill !== 'none' ? hexOf(parseColor(style.fill)) : null,
        color: hexOf(parseColor(style.color)),
      };
      const matchesAccent = !!accent && [
        parseColor(style.stroke), parseColor(style.borderTopColor), parseColor(style.backgroundColor), parseColor(style.fill),
      ].some(colour => colour && colorEquals(colour, accent));
      const animations = reduced ? element.getAnimations({ subtree: true }) : [];
      inScope.push({
        selector, where: describeElement(element), matchesAccent, colourFacts,
        animationCount: animations.length,
      });
      if (!reduced && accent && !matchesAccent) {
        failures.push(`running indicator ${selector} at ${describeElement(element)} is not accent-coloured: ${JSON.stringify(colourFacts)}`);
      }
      if (reduced && animations.length > 0) {
        failures.push(`running indicator ${selector} at ${describeElement(element)} still animates under reduced motion (${animations.length})`);
      }
    }
  }
  if (inScope.length === 0) failures.push('no in-scope activity-shelf or DAG running indicators found');
  let runningLabels = [];
  if (reduced) {
    const labelPattern = /(running|responding|executing|streaming|live|진행|실행|응답)/i;
    const labelSamples = [];
    for (const element of document.querySelectorAll('[aria-label], [title], button, [role="status"], [class*="tool-status"], [class*="termhead"], [class*="status"]')) {
      if (!isVisibleElement(element)) continue;
      const text = (element.textContent || '').trim();
      const label = element.getAttribute('aria-label') || element.getAttribute('title') || '';
      if (labelPattern.test(label)) labelSamples.push({ where: describeElement(element), label: label.slice(0, 60) });
      else if (labelPattern.test(text) && text.length < 60) labelSamples.push({ where: describeElement(element), label: text.slice(0, 60) });
      if (labelSamples.length > 12) break;
    }
    runningLabels = labelSamples.filter((sample, index, all) => all.findIndex(other => other.label === sample.label) === index);
    if (runningLabels.length === 0) failures.push('no textual running label present under reduced motion');
  }
  return {
    scenario: 'S8',
    pass: failures.length === 0,
    measurements: {
      scope: 'activity-shelf-dag',
      phase: reduced ? 'reduced' : 'accent',
      accent: hexOf(accent),
      inScopeCount: inScope.length,
      glyphs: inScope,
      excludedSelectors: Object.keys(excludedCounts).sort(),
      excludedCounts,
      excluded,
      runningLabels,
    },
    failures,
  };
}

// ---------------------------------------------------------------------------
// 4. Driver helpers + scenarios
// ---------------------------------------------------------------------------

const errLine = error => (error instanceof Error ? error.message.split('\n')[0] : String(error));

/** Serve the complete-DAG catalog + document for the current stage. Routes
 * are registered after setup but before the DAG tab opens (the catalog is
 * only fetched once the tab becomes active), so interception is complete. */
async function installDagCatalog(env, chatId, state) {
  await env.page.route(`**/api/workspaces/ws/chats/${chatId}/dag-runs**`, route => {
    const url = new URL(route.request().url());
    const run = t4StageRun(state.stage, state.tick);
    const documentMatch = /\/dag-runs\/[^/]+$/.exec(url.pathname);
    const payload = documentMatch ? t4DocumentPayload(run) : t4CatalogPayload(run);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
}

/** Move the served stage forward and push the matching chat-socket
 * extensionEvents (the channel the real server uses for live DAG
 * updates). */
async function deliverStage(env, chatId, state, stage) {
  state.stage = stage;
  state.tick += 1;
  const run = t4StageRun(stage, state.tick);
  for (const frame of t4ExtensionFrames(run, chatId)) await env.fixture.deliver(chatId, frame);
  return run;
}

/** Open the DAG tab (first graph paint in this page's life) and wait for
 * the running node. */
async function openDagGraph(env) {
  await env.page.click('[data-activity-tab="dag"]');
  await env.page.waitForSelector('.th-activity-gnode--running', { timeout: 9000 });
}

/** Wait until the tablist subtree settles (no running CSS transition/
 * animation), bounded: an infinite animation resolves via the timeout. */
async function settleTablist(page) {
  await page.waitForFunction(() => {
    const tablist = document.querySelector('.th-activity-tabs');
    if (!tablist) return true;
    return tablist.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running');
  }, undefined, { timeout: 1600 }).catch(() => {});
}

/** Wait for a node count (dense stage transitions). */
async function waitForNodeCount(page, count) {
  await page.waitForFunction(expected => document.querySelectorAll('.th-activity-gnode, g[data-node]').length >= expected,
    count, { timeout: 9000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(true))));
}

/** Wait for the running node to be scrolled into the visible reel. */
async function waitForAutoScroll(page, runningId) {
  await page.waitForFunction(id => {
    const node = document.querySelector(`[data-node="${id}"]`);
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    for (let element = node.parentElement; element && element !== document.body; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (/auto|scroll|hidden/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1) {
        const view = element.getBoundingClientRect();
        return (rect.left + rect.right) / 2 >= view.left - 1 && (rect.left + rect.right) / 2 <= view.right + 1;
      }
    }
    return true;
  }, runningId, { timeout: 2500 }).catch(() => {});
}

/** True when the current node state word of `id` mentions `word`. */
async function waitForNodeState(page, id, patternSource) {
  await page.waitForFunction(({ id, patternSource }) => {
    const node = document.querySelector(`[data-node="${id}"]`);
    if (!node) return false;
    const text = (node.querySelector('text[class*="gstate" i], [data-state-word]')?.textContent ?? '')
      + ' ' + (node.getAttribute('class') ?? '');
    return new RegExp(patternSource, 'i').test(text);
  }, { id, patternSource }, { timeout: 9000 }).catch(() => {});
}

function withNotes(env, measurements, notes) {
  return { ...measurements, surfaceNotes: notes, pageErrors: (env?.errors ?? []).slice(0, 5) };
}

// ----- S8 -------------------------------------------------------------------

async function driveS8(ctx) {
  const chatId = ctx.constants.CHAT;
  const env = await ctx.setupLive();
  const notes = [];
  const failures = [];
  const state = { stage: 'mixed', tick: 0 };
  try {
    await installDagCatalog(env, chatId, state);
    await deliverStage(env, chatId, state, 'mixed');
    await openDagGraph(env);
    try {
      const peers = env.fixture.overview(t4ActivityFrame(t4StageRun('mixed', state.tick), chatId));
      notes.push(`overview frame reached ${peers.length} all_live subscriber(s)`);
    } catch (error) {
      notes.push(`overview push unavailable: ${errLine(error)}`);
    }
    // Shelf and DAG indicators only. The transcript tool glyph stays in the
    // census so the exclusion is recorded, and is not judged (T2 owns it;
    // T5 reruns the built-in full S8).
    const colours = await ctx.probe(env.page, probeT4RunningIndicators, { phase: 'accent' });
    failures.push(...colours.failures.map(f => `glyphs: ${f}`));
    // T4 slice: DAG running indicator specifics.
    const dagMotion = await ctx.probe(env.page, probeDagRunningMotion);
    const accentVerdict = dagGlyphAccentVerdict(dagMotion, dagMotion.accent);
    const motionVerdict = dagRunningMotionVerdict(dagMotion);
    failures.push(...accentVerdict.failures.map(f => `dag accent: ${f}`));
    failures.push(...motionVerdict.failures.map(f => `dag motion: ${f}`));
    const shotColour = await ctx.save(env.page, '');
    const motionSweep = await ctx.motionSweep(env.page);
    await env.page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await ctx.probe(env.page, probeT4RunningIndicators, { phase: 'reduced' });
    failures.push(...reduced.failures.map(f => `reduced-motion: ${f}`));
    const dagReduced = await ctx.probe(env.page, probeDagRunningMotion);
    const reducedVerdict = dagReducedMotionVerdict(dagReduced);
    failures.push(...reducedVerdict.failures.map(f => `dag reduced-motion: ${f}`));
    const shotReduced = await ctx.save(env.page, '-reduced');
    return {
      pass: failures.length === 0,
      measurements: withNotes(env, {
        colours: colours.measurements,
        excludedSelectors: colours.measurements.excludedSelectors,
        excludedCounts: colours.measurements.excludedCounts,
        dagMotion: { accent: dagMotion.accent, glyphs: dagMotion.runningGlyphs, comets: dagMotion.comets, halos: dagMotion.halos },
        accentVerdict: accentVerdict.measured, motionVerdict: motionVerdict.measured,
        reducedMotion: reduced.measurements,
        dagReduced: { glyphs: dagReduced.runningGlyphs, comets: dagReduced.comets, halos: dagReduced.halos, stateWords: dagReduced.stateWords },
        motion: motionSweep,
      }, notes),
      failures,
      screenshots: [shotColour, shotReduced],
      teardown: await env.close(),
    };
  } catch (error) {
    failures.push(`harness error: ${errLine(error)}`);
    return {
      pass: false, measurements: withNotes(env, {}, notes), failures,
      screenshots: [], teardown: await env.close(),
    };
  }
}

// ----- S13 ------------------------------------------------------------------

async function driveS13(ctx) {
  const chatId = ctx.constants.CHAT;
  const env = await ctx.setupLive();
  const notes = [];
  const failures = [];
  const state = { stage: 'mixed', tick: 0 };
  try {
    await installDagCatalog(env, chatId, state);
    await deliverStage(env, chatId, state, 'mixed');
    // First paint with the DAG tab selected.
    await openDagGraph(env);
    await settleTablist(env.page);
    const factsA = await ctx.probe(env.page, probeShelfTabs);
    // Roving keys: focus the selected tab deterministically, then verify
    // ArrowRight wraps dag -> todo, End -> dag, Home -> todo (SHELF_TABS
    // order) move selection AND focus AND the single tabindex=0.
    const rovingSteps = [];
    await env.page.focus('[data-activity-tab="dag"]');
    const rovingKey = async (key, expected) => {
      await env.page.keyboard.press(key);
      await env.page.waitForFunction(id => {
        const tab = document.querySelector(`[data-activity-tab="${id}"]`);
        return !!tab && tab.getAttribute('aria-selected') === 'true';
      }, expected, { timeout: 3000 });
      await settleTablist(env.page);
      const step = await ctx.probe(env.page, probeShelfTabs);
      const tabs = step.tabs ?? [];
      rovingSteps.push({
        key, expected,
        selected: step.selectedId,
        activeTab: await env.page.evaluate(() => document.activeElement?.closest('[role="tab"]')?.getAttribute('data-activity-tab') ?? null),
        rovingOk: tabs.length > 0 && tabs.filter(tab => tab.tabIndex === 0).length === 1
          && tabs.find(tab => tab.id === expected)?.tabIndex === 0,
      });
    };
    await rovingKey('ArrowRight', 'todo');
    await rovingKey('End', 'dag');
    await rovingKey('Home', 'todo');
    // Thumb follows a pointer selection too: switch to agents and compare.
    await env.page.click('[data-activity-tab="agents"]');
    await env.page.waitForFunction(() => document.querySelector('.th-activity-shelf')?.getAttribute('data-open') === 'true'
      && document.querySelector('[data-activity-tab="agents"]')?.getAttribute('aria-selected') === 'true', undefined, { timeout: 3000 });
    await settleTablist(env.page);
    const factsB = await ctx.probe(env.page, probeShelfTabs);
    // Enter on the selected tab toggles the shelf closed (behaviour pin).
    await env.page.focus('[data-activity-tab="agents"]');
    await env.page.keyboard.press('Enter');
    let enterClosed = false;
    try {
      await env.page.waitForFunction(() => document.querySelector('.th-activity-shelf')?.getAttribute('data-open') === 'false',
        undefined, { timeout: 3000 });
      enterClosed = true;
    } catch (error) {
      failures.push('Enter on the selected tab did not close the shelf');
    }
    // Reopen for the final capture with counts settled.
    await env.page.click('[data-activity-tab="dag"]');
    await env.page.waitForSelector('.th-activity-gnode--running', { timeout: 9000 });
    await settleTablist(env.page);
    const factsC = await ctx.probe(env.page, probeShelfTabs);
    // Fix roving steps' `selected` semantics for the verdict (active measured
    // separately): rovingVerdict expects selected/active/rovingOk fields.
    for (const step of rovingSteps) step.active = step.activeTab;
    const roving = rovingVerdict(rovingSteps);
    const thumb = thumbVerdict(factsA, factsB);
    const counts = countFontVerdict(factsC.tabs, firstFamily(factsC.monoToken));
    failures.push(...roving.failures.map(f => `roving: ${f}`));
    failures.push(...thumb.failures.map(f => `thumb: ${f}`));
    failures.push(...counts.failures.map(f => `counts: ${f}`));
    if (!factsA.found || !factsB.found || !factsC.found) failures.push('activity tablist not found for S13 measurement');
    const shot = await ctx.save(env.page, '');
    return {
      pass: failures.length === 0,
      measurements: withNotes(env, {
        initial: factsA, afterSwitch: factsB, final: factsC,
        rovingSteps, enterClosedOnSelectedTab: enterClosed,
        thumb: thumb.measured, counts: counts.measured,
      }, notes),
      failures,
      screenshots: [shot],
      teardown: await env.close(),
    };
  } catch (error) {
    failures.push(`harness error: ${errLine(error)}`);
    return {
      pass: false, measurements: withNotes(env, {}, notes), failures,
      screenshots: [], teardown: await env.close(),
    };
  }
}

// ----- S14 ------------------------------------------------------------------

async function driveS14(ctx) {
  const chatId = ctx.constants.CHAT;
  const env = await ctx.setupLive();
  const notes = [];
  const failures = [];
  const state = { stage: 'mixed', tick: 0 };
  try {
    await installDagCatalog(env, chatId, state);
    await deliverStage(env, chatId, state, 'mixed');
    await openDagGraph(env);
    const roles = t4StageRoles('mixed');
    const runningId = roles.running[0];
    const sourceId = roles.completed[roles.completed.length - 1];

    // First graph paint: the reel must scroll the running node into view.
    await waitForAutoScroll(env.page, runningId);
    let facts = await ctx.probe(env.page, probeDagGraph, { runningId, sourceId });
    if (!facts.found) throw new Error(facts.reason ?? 'DAG graph facts unavailable');
    const sourceRect = facts.nodes.find(node => node.id === sourceId)?.rect ?? null;
    const runningEdge = findRunningEdge(facts.edges, sourceRect, facts.runningRect);
    const autoScroll = autoScrollVerdict(facts.scroller ? { scroller: facts.scroller, runningRect: facts.runningRect } : null);
    const strokes = nodeStrokeViolations(facts.nodes.map(node => ({ id: node.id, stroke: node.stroke })), facts.tokens);
    const glyphOrder = glyphOrderVerdict(facts.nodes);
    const edgeShape = edgeShapeVerdict(facts.edges);
    const comet = cometVerdict(facts.comets, runningEdge);
    const halo = haloVerdict(facts.halos, facts.runningRect);
    const progress = progressVerdict((facts.progress ?? []).map(fact => ({
      found: fact.found, where: fact.where, settled: fact.settled,
      scaleX: scaleXFromTransform(fact.transform),
      inlineScaleX: scaleXFromTransform(fact.inlineTransform),
    })), t4ExpectedProgress('mixed'));
    for (const [name, verdict] of [['auto-scroll', autoScroll], ['node strokes', strokes], ['glyph order', glyphOrder],
      ['edge shape', edgeShape], ['comet', comet], ['halo', halo], ['progress', progress]]) {
      failures.push(...verdict.failures.map(f => `${name}: ${f}`));
    }
    const transformsBefore = facts.nodes.map(node => ({ id: node.id, transform: node.transform }));
    const shotGraph = await ctx.save(env.page, '-graph');

    // List view: timeline rail.
    await env.page.click('[data-view="list"]');
    await env.page.waitForSelector('.th-activity-dagnodes > li, [class*="timeline" i]', { timeout: 5000 }).catch(() => {});
    const listFacts = await ctx.probe(env.page, probeDagList);
    const rail = railVerdict(listFacts.rows ?? []);
    failures.push(...rail.failures.map(f => `list rail: ${f}`));
    const shotList = await ctx.save(env.page, '-list');
    await env.page.click('[data-view="graph"]');
    await env.page.waitForSelector('.th-activity-gnode--running', { timeout: 9000 });

    // State-only flip: transforms must be identical, progress advances.
    await deliverStage(env, chatId, state, 'mixed-flip');
    await waitForNodeState(env.page, 'k7', 'completed|--ok');
    await waitForNodeCount(env.page, t4StageSpec('mixed-flip').length);
    facts = await ctx.probe(env.page, probeDagGraph, { runningId, sourceId });
    const stable = stableTransformVerdict(transformsBefore, facts.nodes.map(node => ({ id: node.id, transform: node.transform })));
    const progressFlip = progressVerdict((facts.progress ?? []).map(fact => ({
      found: fact.found, where: fact.where, settled: fact.settled,
      scaleX: scaleXFromTransform(fact.transform),
      inlineScaleX: scaleXFromTransform(fact.inlineTransform),
    })), t4ExpectedProgress('mixed-flip'));
    failures.push(...stable.failures.map(f => `stable layout: ${f}`));
    failures.push(...progressFlip.failures.map(f => `progress after flip: ${f}`));

    // Dense stages: no overlap, no document overflow, progress tracks.
    const denseResults = {};
    for (const stage of ['dense16', 'dense64']) {
      await deliverStage(env, chatId, state, stage);
      await waitForNodeCount(env.page, t4StageSpec(stage).length);
      const denseFacts = await ctx.probe(env.page, probeDagGraph, { runningId: t4StageRoles(stage).running[0], sourceId: null });
      const overlap = overlapVerdict(denseFacts.nodes.map(node => ({ id: node.id, rect: node.rect })));
      const denseProgress = progressVerdict((denseFacts.progress ?? []).map(fact => ({
        found: fact.found, where: fact.where, settled: fact.settled,
        scaleX: scaleXFromTransform(fact.transform),
        inlineScaleX: scaleXFromTransform(fact.inlineTransform),
      })), t4ExpectedProgress(stage));
      const overflow = denseFacts.document.scrollWidth - denseFacts.document.innerWidth;
      failures.push(...overlap.failures.map(f => `${stage} overlap: ${f}`));
      failures.push(...denseProgress.failures.map(f => `${stage} progress: ${f}`));
      if (overflow > 1) failures.push(`${stage}: document overflows viewport by ${overflow}px`);
      denseResults[stage] = {
        nodes: denseFacts.nodes.length, overlap: overlap.overlapping,
        progress: denseProgress.measured, documentScrollWidth: denseFacts.document.scrollWidth,
      };
      notes.push(`${stage}: ${denseFacts.nodes.length} nodes measured`);
    }
    const shotDense = await ctx.save(env.page, '-dense64');
    const motionSweep = await ctx.motionSweep(env.page);
    return {
      pass: failures.length === 0,
      measurements: withNotes(env, {
        graph: {
          nodeCount: facts.nodes.length, edgeCount: facts.edges.length,
          tokens: facts.tokens, runningEdge: runningEdge ? { cls: runningEdge.cls, tag: runningEdge.tag } : null,
        },
        autoScroll: autoScroll.measured, strokes: strokes.violations.slice(0, 12),
        glyphOrder: glyphOrder.measured, edgeShape: edgeShape.measured,
        comet: comet.measured, halo: halo.measured, progress: progress.measured,
        progressAfterFlip: progressFlip.measured, stableLayout: stable.measured,
        list: { rows: (listFacts.rows ?? []).length, viewMode: listFacts.viewMode }, rail: rail.measured,
        dense: denseResults, motion: motionSweep,
        stableLayoutCoveredByUnitTests: 'frontend ActivityShelf.dagClip/stable-layout vitest suites pin the same contract',
      }, notes),
      failures,
      screenshots: [shotGraph, shotList, shotDense],
      teardown: await env.close(),
    };
  } catch (error) {
    failures.push(`harness error: ${errLine(error)}`);
    return {
      pass: false, measurements: withNotes(env, {}, notes), failures,
      screenshots: [], teardown: await env.close(),
    };
  }
}

/** Per-task scenario plugin export (merged over the built-in registry by
 * visual-redesign.mjs; see the plugin contract in its header). */
export const scenarios = Object.freeze({
  S8: driveS8,
  S13: driveS13,
  S14: driveS14,
});
