/** Unit tests for the T4 (activity + DAG) scenario plugin.
 *
 * Covers, per the plugin contract in visual-redesign.mjs:
 *   1. Stage fixtures parse through the PRODUCT'S OWN guards - the complete
 *      document, the catalog page and the WS summary snapshot are validated
 *      by the real frontend parsers (activityCompleteParse.ts /
 *      activityParseDag.ts), so the wire shapes can never drift from the
 *      contract the app enforces.
 *   2. Every pure verdict the drivers apply (thumb/roving/counts, edge
 *      shape, glyph order, node strokes, comet/halo, progress scaleX,
 *      auto-scroll, rail, overlap, stable transforms, reduced motion).
 *   3. Plugin registration: the module exports scenarios S8/S13/S14 and the
 *      shared loader picks it up, overriding the built-in stubs/registry.
 *   4. Self-containment (the D6 class): the in-page probes serialize into
 *      the browser with only pageKit() ahead of them, so any free
 *      identifier that is not a kit helper or a page global crashes
 *      in-page - the scan below catches that class before the browser run.
 *
 * Run: bun test test/qa/visual-redesign-scenarios-t4.test.mjs
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildScenarioRegistry, loadScenarioPlugins } from './visual-redesign.mjs';
import { pageKit } from './visual-redesign-probes.mjs';
import {
  T4_RUN, T4_STAGE_ORDER, autoScrollVerdict, cometVerdict, countFontVerdict, dagGlyphAccentVerdict,
  dagReducedMotionVerdict, dagRunningMotionVerdict, edgeShapeVerdict, findRunningEdge, firstFamily,
  denseFadeVerdict, glyphOrderVerdict, haloVerdict, nodeStrokeViolations, overlapVerdict, progressVerdict,
  probeDagGraph, probeDagList, probeDagRunningMotion, probeDenseViewport, probeShelfTabs, probeT4RunningIndicators,
  railVerdict, rovingVerdict, scaleXFromTransform, scenarios, stableTransformVerdict,
  settleTablist,
  t4ActivityFrame, t4CatalogPayload, t4DocumentPayload, t4ExpectedProgress, t4ExtensionFrames,
  t4RunCounts, t4StageRoles, t4StageRun, t4StageSpec, thumbVerdict,
} from './visual-redesign-scenarios-t4.mjs';
import { parseCompleteDag, parseDagCatalog } from '../../frontend/src/features/split/activityCompleteParse.ts';
import { parseDagUpdated } from '../../frontend/src/features/split/activityParseDag.ts';
import { validatedActivityEvent } from '../../frontend/src/features/split/activityState.ts';

const rect = (left, top, width, height) => ({
  left, top, right: left + width, bottom: top + height, width, height,
});

// ---------------------------------------------------------------------------
// 1. Stage fixtures vs the product's own parsers
// ---------------------------------------------------------------------------

describe('T4 stage fixtures pass the real product parsers', () => {
  test('every stage builds a complete document parseCompleteDag accepts', () => {
    for (const stage of T4_STAGE_ORDER) {
      const run = t4StageRun(stage, T4_STAGE_ORDER.indexOf(stage) + 1);
      const parsed = parseCompleteDag(t4DocumentPayload(run));
      expect(parsed).not.toBeNull();
      expect(parsed.run.runId).toBe(T4_RUN.id);
      expect(parsed.run.nodes).toHaveLength(run.nodes.length);
      expect(parsed.run.counts.total).toBe(run.counts.total);
      expect(parsed.run.counts.completed).toBe(run.counts.completed);
      expect(parsed.run.counts.running).toBe(run.counts.running);
    }
  });
  test('every stage builds a catalog page parseDagCatalog accepts', () => {
    for (const stage of T4_STAGE_ORDER) {
      const page = parseDagCatalog(t4CatalogPayload(t4StageRun(stage, 1)));
      expect(page).not.toBeNull();
      expect(page.runs).toHaveLength(1);
      expect(page.runs[0].runId).toBe(T4_RUN.id);
      expect(page.nextCursor).toBeNull();
    }
  });
  test('the WS summary frame parses through parseDagUpdated with exact scalars', () => {
    for (const stage of T4_STAGE_ORDER) {
      const run = t4StageRun(stage, 1);
      const frame = t4ActivityFrame(run, 'stored-a');
      const dag = parseDagUpdated(frame.snapshots.find(snapshot => snapshot.name === 'omo.dag.updated').data);
      expect(dag).not.toBeNull();
      expect(dag.dagRunRunningCount).toBe(run.counts.running > 0 ? 1 : 0);
      expect(dag.dagRunTotalCount).toBe(1);
      expect(dag.runs[0].truncated).toBeUndefined();
    }
  });
  test('chat-socket extensionEvents carry snapshots the product frame handler accepts', () => {
    // The chat socket consumes activity as extensionEvent frames; a
    // sessions.activity-shaped delivery on that socket is silently ignored
    // (the live defect this test pins).
    for (const stage of T4_STAGE_ORDER) {
      const frames = t4ExtensionFrames(t4StageRun(stage, 1), 'stored-a');
      expect(frames).toHaveLength(2);
      for (const frame of frames) {
        expect(frame.type).toBe('extensionEvent');
        expect(frame.sessionId).toBe('stored-a');
        expect(['omo.task.updated', 'omo.dag.updated']).toContain(frame.name);
        expect(validatedActivityEvent(frame.name, frame.data)).not.toBeNull();
      }
      const dag = parseDagUpdated(frames.find(frame => frame.name === 'omo.dag.updated').data);
      expect(dag).not.toBeNull();
      expect(dag.runs[0].nodes).toHaveLength(t4StageSpec(stage).length);
    }
  });
  test('counts are the exact state histogram (the doc parser recomputes it)', () => {
    for (const stage of T4_STAGE_ORDER) {
      const spec = t4StageSpec(stage);
      const counts = t4RunCounts(spec);
      expect(counts.total).toBe(spec.length);
      const sum = counts.pending + counts.blocked + counts.scheduled + counts.running
        + counts.completed + counts.failed + counts.cancelled + counts.skipped;
      expect(sum).toBe(spec.length);
    }
  });
  test('stage topology: unique ids, edges mirror dependencies, waves cover every node once', () => {
    for (const stage of T4_STAGE_ORDER) {
      const spec = t4StageSpec(stage);
      const ids = new Set(spec.map(node => node.id));
      expect(ids.size).toBe(spec.length);
      for (const node of spec) for (const dep of node.deps) expect(ids.has(dep)).toBe(true);
      const run = t4StageRun(stage, 1);
      const dependencyPairs = spec.flatMap(node => node.deps.map(dep => `${dep}->${node.id}`)).sort();
      const edgePairs = run.edges.map(edge => `${edge.from}->${edge.to}`).sort();
      expect(edgePairs).toEqual(dependencyPairs);
      const waveIds = run.waves.flatMap(wave => wave.node_ids);
      expect(new Set(waveIds).size).toBe(spec.length);
      expect(waveIds.length).toBe(spec.length);
    }
  });
  test('revisions strictly increase across the delivery order', () => {
    let previous = 0;
    T4_STAGE_ORDER.forEach((stage, index) => {
      const at = Date.parse(t4StageRun(stage, index + 1).updated_at);
      expect(at).toBeGreaterThan(previous);
      previous = at;
    });
  });
  test('stage roles and expected progress ratios', () => {
    expect(t4StageRoles('mixed').running).toEqual(['k6']);
    expect(t4StageRoles('mixed').completed).toHaveLength(6);
    expect(t4StageRoles('mixed').failed).toEqual(['f']);
    expect(t4ExpectedProgress('mixed')).toBeCloseTo(6 / 11, 10);
    expect(t4ExpectedProgress('mixed-flip')).toBeCloseTo(7 / 11, 10);
    const terminal = t4RunCounts([
      { state: 'completed' }, { state: 'failed' }, { state: 'skipped' }, { state: 'cancelled' },
    ]);
    expect(terminal.completed).toBe(1);
    expect(terminal.total).toBe(4);
    expect(t4ExpectedProgress('dense16')).toBeCloseTo(4 / 16, 10);
    expect(t4ExpectedProgress('dense64')).toBeCloseTo(8 / 64, 10);
  });
  test('dense stages have the promised node counts', () => {
    expect(t4StageSpec('dense16')).toHaveLength(16);
    expect(t4StageSpec('dense64')).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------
// 2. Pure verdicts
// ---------------------------------------------------------------------------

describe('scaleXFromTransform / progressVerdict (S14 progress bar)', () => {
  test('matrix and matrix3d scale extraction; none/unparsable -> null', () => {
    expect(scaleXFromTransform('matrix(0.6, 0, 0, 1, 0, 0)')).toBeCloseTo(0.6, 10);
    expect(scaleXFromTransform('matrix(0.545455, 0, 0, 1, 12, 0)')).toBeCloseTo(0.545455, 6);
    expect(scaleXFromTransform('matrix3d(0.6, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)')).toBeCloseTo(0.6, 10);
    expect(scaleXFromTransform('scaleX(0.6)')).toBeCloseTo(0.6, 10);
    expect(scaleXFromTransform('none')).toBeNull();
    expect(scaleXFromTransform('')).toBeNull();
    expect(scaleXFromTransform('translateX(10px)')).toBeNull();
  });
  test('progress verdict: within tolerance passes, beyond fails, no bar fails', () => {
    const facts = [{ found: true, where: 'div.x', settled: true, inlineScaleX: 6 / 11, scaleX: scaleXFromTransform('matrix(0.545455, 0, 0, 1, 0, 0)') }];
    expect(progressVerdict(facts, 6 / 11).pass).toBe(true);
    const off = [{ ...facts[0], scaleX: 0.4 }];
    const verdict = progressVerdict(off, 6 / 11);
    expect(verdict.pass).toBe(false);
    expect(verdict.failures[0]).toContain('scaleX');
    expect(progressVerdict([], 0.5).pass).toBe(false);
    expect(progressVerdict([{ ...facts[0], scaleX: null }], 0.5).pass).toBe(false);
    expect(progressVerdict([{ ...facts[0], inlineScaleX: 0.4 }], 6 / 11).pass).toBe(false);
    expect(progressVerdict([{ ...facts[0], settled: false }], 6 / 11).pass).toBe(false);
    expect(progressVerdict([{ ...facts[0], countText: '6/11 done' }], 6 / 11, '6/11').pass).toBe(true);
    expect(progressVerdict([{ ...facts[0], countText: '7/11 done' }], 6 / 11, '6/11').pass).toBe(false);
    expect(progressVerdict([{ ...facts[0], countText: null }], 6 / 11, '6/11').pass).toBe(false);
    // Boundary: exactly 0.01 delta is inside the contract.
    expect(progressVerdict([{ ...facts[0], scaleX: 0.61, inlineScaleX: 0.6 }], 0.6).pass).toBe(true);
  });
});

describe('edgeShapeVerdict (S14 bezier edges)', () => {
  test('baseline <line> edges fail; <path> with C passes; straight path fails; defs excluded', () => {
    expect(edgeShapeVerdict([{ tag: 'line', d: null, inDefs: false }]).pass).toBe(false);
    expect(edgeShapeVerdict([
      { tag: 'path', d: 'M10 30 C 20 10, 40 10, 50 30', inDefs: false },
      { tag: 'path', d: 'M60 30 L 80 30', inDefs: false },
    ]).pass).toBe(false);
    expect(edgeShapeVerdict([
      { tag: 'path', d: 'M10 30 C 20 10, 40 10, 50 30', inDefs: false },
      { tag: 'path', d: 'M0,0L8,3L0,6Z', inDefs: true }, // marker head
    ]).pass).toBe(true);
    expect(edgeShapeVerdict([]).pass).toBe(false);
  });
});

describe('glyphOrderVerdict (S14 glyph left of label)', () => {
  test('glyph left passes; glyph right fails (baseline); no judgeable node fails', () => {
    const left = [
      { id: 'k0', glyph: { left: 10, width: 10 }, label: { left: 26 } },
      { id: 'k6', glyph: { left: 8, width: 12 }, label: { left: 24 } },
    ];
    expect(glyphOrderVerdict(left).pass).toBe(true);
    const right = [
      { id: 'k0', glyph: { left: 120, width: 10 }, label: { left: 8 } },
      { id: 'k6', glyph: { left: 8, width: 10 }, label: { left: 24 } },
    ];
    expect(glyphOrderVerdict(right).pass).toBe(false);
    expect(glyphOrderVerdict([{ id: 'k7', glyph: null, label: { left: 8 } }]).pass).toBe(false);
  });
});

describe('nodeStrokeViolations (S14 no state strokes)', () => {
  const tokens = { success: '#16a34a', warning: '#d97706', error: '#dc2626', accent: '#8b7cf6' };
  test('state-token strokes are flagged; neutral hairlines are not', () => {
    const violations = nodeStrokeViolations([
      { id: 'k0', stroke: 'rgb(22, 163, 74)' },   // success stroke (baseline ok-node)
      { id: 'k6', stroke: 'rgb(217, 119, 6)' },   // warning stroke (baseline running-node)
      { id: 'k7', stroke: 'rgba(255, 255, 255, 0.06)' }, // hairline
    ], tokens);
    expect(violations.pass).toBe(false);
    expect(violations.violations.map(v => v.id).sort()).toEqual(['k0', 'k6']);
    const clean = nodeStrokeViolations([{ id: 'k0', stroke: 'rgba(255,255,255,0.06)' }, { id: 'k6', stroke: 'rgb(29,30,34)' }], tokens);
    expect(clean.pass).toBe(true);
  });
  test('accent strokes on node cards are flagged too (state-by-colour)', () => {
    expect(nodeStrokeViolations([{ id: 'k6', stroke: '#8b7cf6' }], tokens).pass).toBe(false);
  });
});

describe('findRunningEdge + cometVerdict (S14 comet)', () => {
  const fromRect = rect(100, 50, 160, 60);
  const toRect = rect(300, 50, 160, 60);
  const edges = [
    { tag: 'path', d: 'M...', inDefs: false, rect: rect(255, 70, 50, 20), p0: { x: 260, y: 80 }, p1: { x: 300, y: 80 } },
    { tag: 'path', d: 'M...', inDefs: false, rect: rect(455, 70, 50, 20), p0: { x: 460, y: 80 }, p1: { x: 505, y: 80 } },
  ];
  test('the edge leaving the completed node and entering the running node is matched', () => {
    expect(findRunningEdge(edges, fromRect, toRect)).toBe(edges[0]);
    expect(findRunningEdge(edges, toRect, fromRect)).toBe(edges[0]);
    expect(findRunningEdge(edges, rect(900, 400, 50, 50), toRect)).toBeNull();
  });
  test('comet verdict: animated + riding the running edge passes; static or off-edge fails; missing fails', () => {
    const riding = [{ found: true, rect: rect(250, 65, 40, 18), runningAnimations: 2 }];
    expect(cometVerdict(riding, edges[0]).pass).toBe(true);
    expect(cometVerdict([{ found: true, rect: rect(250, 65, 40, 18), runningAnimations: 0 }], edges[0]).pass).toBe(false);
    expect(cometVerdict([{ found: true, rect: rect(700, 300, 40, 18), runningAnimations: 2 }], edges[0]).pass).toBe(false);
    expect(cometVerdict([], edges[0]).pass).toBe(false);
    expect(cometVerdict(riding, null).pass).toBe(false);
  });
});

describe('haloVerdict (S14 running node halo)', () => {
  const nodeRect = rect(300, 50, 160, 60);
  test('in-group or intersecting halo passes; invisible or missing fails', () => {
    expect(haloVerdict([{ found: true, rect: rect(295, 45, 170, 70), insideRunningNode: true }], nodeRect).pass).toBe(true);
    expect(haloVerdict([{ found: true, rect: rect(295, 45, 170, 70), insideRunningNode: false }], nodeRect).pass).toBe(true);
    expect(haloVerdict([{ found: true, rect: rect(0, 0, 0, 0), insideRunningNode: false }], nodeRect).pass).toBe(false);
    expect(haloVerdict([], nodeRect).pass).toBe(false);
  });
});

describe('autoScrollVerdict (S14 first-paint auto-scroll)', () => {
  // Measured rects are viewport coordinates (getBoundingClientRect), i.e.
  // already scroll-adjusted: after scrollLeft 700 a node at content x 900
  // appears at viewport x 200.
  test('overflow with scrollLeft and centered node passes; scrollLeft 0 fails (baseline)', () => {
    const scroller = { where: 'div.graph', scrollLeft: 700, scrollWidth: 1800, clientWidth: 700, rect: rect(0, 0, 700, 300) };
    expect(autoScrollVerdict({ scroller, runningRect: rect(200, 40, 160, 60) }).pass).toBe(true);
    expect(autoScrollVerdict({ scroller: { ...scroller, scrollLeft: 0 }, runningRect: rect(900, 40, 160, 60) }).pass).toBe(false);
    expect(autoScrollVerdict({ scroller, runningRect: rect(900, 40, 160, 60) }).pass).toBe(false);
    expect(autoScrollVerdict({ scroller: null, runningRect: rect(200, 40, 160, 60) }).pass).toBe(false);
  });
  test('no horizontal overflow is a skip, not a failure', () => {
    const verdict = autoScrollVerdict({ scroller: { where: 'div.graph', scrollLeft: 0, scrollWidth: 600, clientWidth: 700, rect: rect(0, 0, 700, 300) }, runningRect: rect(200, 40, 160, 60) });
    expect(verdict.pass).toBe(true);
    expect(verdict.measured.skipped).toBeDefined();
  });
  test('overflow need not scroll when the first running node already occupies the initial viewport', () => {
    const scroller = { where: 'div.graph', scrollLeft: 0, scrollWidth: 1800, clientWidth: 700, rect: rect(0, 0, 700, 300) };
    expect(autoScrollVerdict({ scroller, runningRect: rect(300, 40, 160, 60) }).pass).toBe(true);
  });
});

describe('railVerdict (S14 list view timeline)', () => {
  test('only painted rail geometry in selected List mode counts', () => {
    expect(railVerdict([{ paintedRail: true }, { paintedRail: true }], 'list').pass).toBe(true);
    const verdict = railVerdict([{ paintedRail: false }, { paintedRail: true }], 'list');
    expect(verdict.pass).toBe(false);
    expect(verdict.failures[0]).toContain('1/2');
    expect(railVerdict([{ paintedRail: true }], 'graph').pass).toBe(false);
    expect(railVerdict([], 'list').pass).toBe(false);
  });
});

describe('overlapVerdict (S14 dense graphs)', () => {
  test('overlapping node boxes are flagged; touching neighbours are not', () => {
    const nodes = [
      { id: 'a', rect: rect(0, 0, 140, 60) },
      { id: 'b', rect: rect(164, 0, 140, 60) },      // one gap apart: clean
      { id: 'c', rect: rect(0, 72, 140, 60) },       // vertical gap: clean
    ];
    expect(overlapVerdict(nodes).pass).toBe(true);
    const overlapping = [...nodes, { id: 'd', rect: rect(100, 20, 140, 60) }];
    const verdict = overlapVerdict(overlapping);
    expect(verdict.pass).toBe(false);
    expect(verdict.overlapping.length).toBeGreaterThan(0);
  });
});

describe('stableTransformVerdict (S14 state change keeps geometry)', () => {
  test('identical transforms pass; a change or new node fails', () => {
    const before = [{ id: 'k0', transform: 'translate(6, 6)' }, { id: 'k6', transform: 'translate(600, 6)' }];
    const same = [{ id: 'k0', transform: 'translate(6, 6)' }, { id: 'k6', transform: 'translate(600, 6)' }];
    expect(stableTransformVerdict(before, same).pass).toBe(true);
    const changed = [{ id: 'k0', transform: 'translate(6, 6)' }, { id: 'k6', transform: 'translate(610, 6)' }];
    expect(stableTransformVerdict(before, changed).pass).toBe(false);
    const added = [...same, { id: 'new', transform: 'translate(0, 0)' }];
    expect(stableTransformVerdict(before, added).pass).toBe(false);
    expect(stableTransformVerdict([], same).pass).toBe(false);
  });
});

describe('thumbVerdict + rovingVerdict + countFontVerdict (S13)', () => {
  const tabs = [
    { id: 'todo', rect: rect(0, 0, 100, 32) },
    { id: 'agents', rect: rect(104, 0, 100, 32) },
    { id: 'dag', rect: rect(208, 0, 100, 32) },
  ];
  test('transform change + alignment passes; identical transform fails (left-mover)', () => {
    const before = { thumbCount: 1, thumb: { found: true, painted: true, identity: 'same', transform: 'matrix(1, 0, 0, 1, 208, 0)', rect: rect(210, 2, 96, 28) }, selectedId: 'dag', tabs };
    const after = { thumbCount: 1, thumb: { found: true, painted: true, identity: 'same', transform: 'matrix(1, 0, 0, 1, 104, 0)', rect: rect(106, 2, 96, 28) }, selectedId: 'agents', tabs };
    expect(thumbVerdict(before, after).pass).toBe(true);
    const staticThumb = { ...after, thumb: { ...after.thumb, transform: before.thumb.transform } };
    expect(thumbVerdict(before, staticThumb).pass).toBe(false);
    const misaligned = { thumb: { found: true, transform: 'matrix(1,0,0,1,0,0)', rect: rect(0, 2, 96, 28) }, selectedId: 'agents', tabs };
    expect(thumbVerdict(before, misaligned).pass).toBe(false);
    expect(thumbVerdict({ thumbCount: 0, thumb: { found: false }, selectedId: 'dag', tabs }, after).pass).toBe(false);
    expect(thumbVerdict(before, { ...after, thumbCount: 2 }).pass).toBe(false);
    expect(thumbVerdict(before, { ...after, thumb: { ...after.thumb, painted: false } }).pass).toBe(false);
    expect(thumbVerdict(before, { ...after, thumb: { ...after.thumb, identity: 'replacement' } }).pass).toBe(false);
  });
  test('roving steps must move selection AND focus AND the tabindex', () => {
    const good = [
      { key: 'ArrowRight', expected: 'todo', selected: 'todo', active: 'todo', rovingOk: true },
      { key: 'End', expected: 'dag', selected: 'dag', active: 'dag', rovingOk: true },
      { key: 'Home', expected: 'todo', selected: 'todo', active: 'todo', rovingOk: true },
    ];
    expect(rovingVerdict(good).pass).toBe(true);
    const focusLost = [{ key: 'ArrowRight', expected: 'todo', selected: 'todo', active: 'dag', rovingOk: true }];
    expect(rovingVerdict(focusLost).pass).toBe(false);
    const tabIdle = [{ key: 'End', expected: 'dag', selected: 'dag', active: 'dag', rovingOk: false }];
    expect(rovingVerdict(tabIdle).pass).toBe(false);
    expect(rovingVerdict([]).pass).toBe(false);
  });
  test('mono counts fail (baseline), sans counts pass, absent counts fail', () => {
    const mono = firstFamily('"JetBrains Mono", ui-monospace, monospace');
    const sans = firstFamily('"Pretendard Variable", Pretendard, sans-serif');
    const baseline = [
      { id: 'todo', count: { text: '0/3', family: '"JetBrains Mono", monospace', visible: true } },
      { id: 'agents', count: { text: '0/18', family: '"JetBrains Mono", monospace', visible: true } },
    ];
    expect(countFontVerdict(baseline, mono).pass).toBe(false);
    const redesigned = [
      { id: 'todo', count: { text: '0/3', family: '"Pretendard Variable", sans-serif', visible: true } },
      { id: 'agents', count: { text: '0/18', family: '"Pretendard Variable", sans-serif', visible: true } },
    ];
    expect(countFontVerdict(redesigned, mono).pass).toBe(true);
    // The mono token comparison is by first family, not substring luck.
    const sneaky = [{ id: 'dag', count: { text: '1/1', family: 'JetBrains Mono', visible: true } }];
    expect(countFontVerdict(sneaky, mono).pass).toBe(false);
    expect(countFontVerdict([{ id: 'todo', count: null }], mono).pass).toBe(false);
    const hidden = [{ id: 'dag', count: { text: '1/1', family: '"Pretendard Variable"', visible: false } }];
    expect(countFontVerdict(hidden, mono).pass).toBe(false);
  });
});

describe('dagRunningMotion / accent / reduced verdicts (S8)', () => {
  test('normal motion requires an animated running glyph', () => {
    const animated = { runningGlyphs: [{ found: true, where: 'circle.gstatus--running', runningAnimations: 1 }] };
    expect(dagRunningMotionVerdict(animated).pass).toBe(true);
    const staticGlyph = { runningGlyphs: [{ found: true, where: 'circle.gstatus--running', runningAnimations: 0 }] };
    expect(dagRunningMotionVerdict(staticGlyph).pass).toBe(false);
    expect(dagRunningMotionVerdict({ runningGlyphs: [] }).pass).toBe(false);
  });
  test('accent verdict: violet glyph passes, amber (baseline) fails', () => {
    const facts = { runningGlyphs: [{ found: true, where: 'circle', stroke: 'rgb(139, 124, 246)', color: 'rgb(237, 237, 240)', background: 'rgba(0,0,0,0)', fill: 'none', border: 'rgb(0,0,0,0)' }] };
    expect(dagGlyphAccentVerdict(facts, '#8b7cf6').pass).toBe(true);
    const amber = { runningGlyphs: [{ found: true, where: 'circle', stroke: 'rgb(217, 119, 6)', color: 'rgb(217, 119, 6)' }] };
    expect(dagGlyphAccentVerdict(amber, '#8b7cf6').pass).toBe(false);
    expect(dagGlyphAccentVerdict({ runningGlyphs: [] }, '#8b7cf6').pass).toBe(false);
    expect(dagGlyphAccentVerdict(facts, '').pass).toBe(false);
  });
  test('reduced motion: zero animations everywhere plus a textual state word', () => {
    const calm = {
      runningGlyphs: [{ found: true, where: 'circle', runningAnimations: 0 }],
      comets: [{ found: true, where: 'circle.comet', runningAnimations: 0 }],
      halos: [{ found: true, where: 'circle.halo', runningAnimations: 0 }],
      stateWords: [{ node: 'k6', text: 'Running', visible: true }],
    };
    expect(dagReducedMotionVerdict(calm).pass).toBe(true);
    const spinning = { ...calm, runningGlyphs: [{ found: true, where: 'circle', runningAnimations: 1 }] };
    expect(dagReducedMotionVerdict(spinning).pass).toBe(false);
    const cometStill = { ...calm, comets: [{ found: true, where: 'circle.comet', runningAnimations: 1 }] };
    expect(dagReducedMotionVerdict(cometStill).pass).toBe(false);
    const wordless = { ...calm, stateWords: [{ node: 'k6', text: 'Running', visible: false }] };
    expect(dagReducedMotionVerdict(wordless).pass).toBe(false);
    const korean = { ...calm, stateWords: [{ node: 'k6', text: '실행 중', visible: true }] };
    expect(dagReducedMotionVerdict(korean).pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Plugin registration
// ---------------------------------------------------------------------------

describe('T4 plugin registration', () => {
  test('settleTablist propagates a bounded animation timeout', async () => {
    const timeout = new Error('Timeout 1600ms exceeded');
    const page = { waitForFunction: async (predicate, arg, options) => {
      expect(options.timeout).toBe(1600);
      throw timeout;
    } };
    expect(settleTablist(page)).rejects.toThrow('Timeout 1600ms exceeded');
  });
  test('the module registers S8/S13/S14 over the built-in registry', async () => {
    // Scan the REAL test/qa directory: relative imports inside the plugin
    // (visual-redesign-probes.mjs) only resolve in place, never from a copy.
    const plugins = await loadScenarioPlugins(import.meta.dir);
    const mine = plugins.find(plugin => plugin.file === 'visual-redesign-scenarios-t4.mjs');
    expect(mine).toBeDefined();
    expect(mine.skipped).toBeUndefined();
    expect(Object.keys(mine.scenarios).sort()).toEqual(['S13', 'S14', 'S15', 'S8']);
    const registry = buildScenarioRegistry(plugins);
    for (const id of ['S8', 'S13', 'S14', 'S15']) {
      const entry = registry.find(candidate => candidate.id === id);
      expect(entry.origin).toBe('plugin:visual-redesign-scenarios-t4.mjs');
      expect(entry.stub).toBe(false);
      expect(typeof entry.run).toBe('function');
    }
    // The plugin replaces the built-in S8 driver (origin flips) and the
    // untouched built-ins stay put.
    expect(registry.find(candidate => candidate.id === 'S1').origin).toBe('builtin');
    expect(registry.find(candidate => candidate.id === 'S1').run).toBeInstanceOf(Function);
  });
  test('the scenarios export includes S15 settled capture without losing its built-in motion driver', () => {
    expect(Object.keys(scenarios).sort()).toEqual(['S13', 'S14', 'S15', 'S8']);
    for (const run of Object.values(scenarios)) expect(run.constructor.name).toBe('AsyncFunction');
    expect(scenarios.S15.toString()).toContain('original(browser, ctx, async');
  });
});

// ---------------------------------------------------------------------------
// 4. Self-containment (D6): probes may reference only kit helpers + page
//    globals. Adapted from visual-redesign-probes.test.mjs.
// ---------------------------------------------------------------------------

const PAGE_GLOBALS = new Set([
  'document', 'window', 'getComputedStyle', 'Element', 'Node', 'NodeFilter', 'HTMLElement',
  'CSSAnimation', 'CSSTransition', 'requestAnimationFrame', 'fetch', 'console',
  'setTimeout', 'clearTimeout', 'getSelection', 'MutationObserver', 'ResizeObserver',
  'SVGGeometryElement', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON',
  'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Promise', 'Symbol', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'Intl', 'BigInt', 'parseInt', 'parseFloat',
  'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'structuredClone',
  'globalThis', 'URL', 'URLSearchParams', 'Event', 'CustomEvent', 'undefined',
]);
const JS_NON_REFERENCES = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if',
  'import', 'in', 'instanceof', 'let', 'new', 'of', 'return', 'super', 'switch', 'this', 'throw',
  'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'await', 'async', 'static', 'get', 'set',
  'true', 'false', 'null', 'undefined', 'arguments', 'NaN', 'Infinity']);

/** Mask strings, template-literal text, comments and regex bodies so the
 * identifier scan only sees code tokens. Template `${...}` parts are kept
 * (recursively) because they contain real references. Ported from the
 * proven scanner in visual-redesign-probes.test.mjs so both harnesses share
 * one scanner semantics. */
function maskSource(source) {
  const out = [];
  let i = 0;
  const sig = () => {
    for (let j = out.length - 1; j >= 0; j -= 1) if (!/\s/.test(out[j])) return out[j];
    return '';
  };
  const regexAllowed = () => !/[A-Za-z0-9_$)\]"']/.test(sig());
  function readString(quote) {
    out.push(quote); i += 1;
    while (i < source.length && source[i] !== quote) {
      if (source[i] === '\\') { out.push(' ', ' '); i += 2; continue; }
      out.push(source[i] === '\n' ? '\n' : ' '); i += 1;
    }
    if (i < source.length) { out.push(quote); i += 1; }
  }
  function readTemplate() {
    while (i < source.length) {
      const c = source[i];
      if (c === '\\') { out.push(' ', ' '); i += 2; continue; }
      if (c === '`') { out.push('`'); i += 1; return; }
      if (c === '$' && source[i + 1] === '{') {
        out.push(' ', '{'); i += 2;
        readCode(true);
        if (source[i] === '}') { out.push('}'); i += 1; }
        continue;
      }
      out.push(c === '\n' ? '\n' : ' '); i += 1;
    }
  }
  function readRegex() {
    out.push('/'); i += 1;
    let inClass = false;
    while (i < source.length) {
      const c = source[i];
      if (c === '\\') { out.push(' ', ' '); i += 2; continue; }
      if (c === '\n') break;
      out.push(' '); i += 1;
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
    }
    if (source[i] === '/') { out.push('/'); i += 1; }
    while (i < source.length && /[a-z]/i.test(source[i])) { out.push(' '); i += 1; }
  }
  function readCode(stopAtBrace) {
    let depth = 0;
    while (i < source.length) {
      const c = source[i];
      if (stopAtBrace && c === '}' && depth === 0) return;
      if (c === '{') { depth += 1; out.push(c); i += 1; continue; }
      if (c === '}') { depth -= 1; out.push(c); i += 1; continue; }
      if (c === '"' || c === "'") { readString(c); continue; }
      if (c === '`') { out.push('`'); i += 1; readTemplate(); continue; }
      if (c === '/' && source[i + 1] === '/') {
        while (i < source.length && source[i] !== '\n') { out.push(' '); i += 1; }
        continue;
      }
      if (c === '/' && source[i + 1] === '*') {
        const end = source.indexOf('*/', i + 2);
        const stop = end === -1 ? source.length : end + 2;
        while (i < stop) { out.push(source[i] === '\n' ? '\n' : ' '); i += 1; }
        continue;
      }
      if (c === '/' && regexAllowed()) { readRegex(); continue; }
      out.push(c); i += 1;
    }
  }
  readCode(false);
  return out.join('');
}

function identifierTokens(masked) {
  const tokens = [];
  const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let match;
  while ((match = re.exec(masked))) tokens.push({ name: match[0], start: match.index, end: match.index + match[0].length });
  return tokens;
}

function neighbours(masked, start, end) {
  let prev = '', prev2 = '', next = '';
  for (let j = start - 1; j >= 0; j -= 1) {
    if (!/\s/.test(masked[j])) {
      prev = masked[j];
      for (let k = j - 1; k >= 0; k -= 1) if (!/\s/.test(masked[k])) { prev2 = masked[k]; break; }
      break;
    }
  }
  for (let j = end; j < masked.length; j += 1) if (!/\s/.test(masked[j])) { next = masked[j]; break; }
  return { prev, prev2, next };
}

/** Identifiers in reference position: property accesses (a.b, a?.b) and
 * object-literal keys ({ key: ... } incl. after a comma) are excluded;
 * shorthand counts. */
function referencesIn(masked) {
  const refs = new Set();
  for (const token of identifierTokens(masked)) {
    if (JS_NON_REFERENCES.has(token.name)) continue;
    const { prev, prev2, next } = neighbours(masked, token.start, token.end);
    if (prev === '.' || (prev === '?' && prev2 === '.')) continue;
    if (next === ':' && (prev === '{' || prev === ',')) continue;
    refs.add(token.name);
  }
  return refs;
}

function declaredNames(masked) {
  const names = new Set();
  const addIdentifierList = body => {
    for (const token of identifierTokens(body)) {
      if (JS_NON_REFERENCES.has(token.name)) continue;
      const { prev, next } = neighbours(body, token.start, token.end);
      if (prev === '.') continue;
      if (next === ',' || next === '=' || next === '') names.add(token.name);
    }
  };
  const balancedEnd = (openIndex) => {
    const open = masked[openIndex];
    const close = open === '(' ? ')' : open === '[' ? ']' : '}';
    let depth = 0;
    for (let j = openIndex; j < masked.length; j += 1) {
      if (masked[j] === open) depth += 1;
      else if (masked[j] === close) { depth -= 1; if (depth === 0) return j; }
    }
    return openIndex;
  };
  const fnRe = /\bfunction\b\s*([A-Za-z_$][A-Za-z0-9_$]*)?\s*\(/g;
  let m;
  while ((m = fnRe.exec(masked))) {
    if (m[1]) names.add(m[1]);
    const open = m.index + m[0].length - 1;
    addIdentifierList(masked.slice(open + 1, balancedEnd(open)));
  }
  const catchRe = /\bcatch\s*\(/g;
  while ((m = catchRe.exec(masked))) {
    const open = m.index + m[0].length - 1;
    const end = balancedEnd(open);
    for (const token of identifierTokens(masked.slice(open + 1, end))) {
      if (!JS_NON_REFERENCES.has(token.name)) names.add(token.name);
    }
  }
  const arrowRe = /=>/g;
  while ((m = arrowRe.exec(masked))) {
    let j = m.index - 1;
    while (j >= 0 && /\s/.test(masked[j])) j -= 1;
    if (j >= 0 && masked[j] === ')') {
      let depth = 0;
      for (; j >= 0; j -= 1) {
        if (masked[j] === ')') depth += 1;
        else if (masked[j] === '(') { depth -= 1; if (depth === 0) break; }
      }
      if (j >= 0) addIdentifierList(masked.slice(j + 1, m.index - 1).replace(/\)\s*$/, ''));
    } else if (j >= 0 && /[A-Za-z0-9_$]/.test(masked[j])) {
      let start = j;
      while (start >= 0 && /[A-Za-z0-9_$]/.test(masked[start])) start -= 1;
      names.add(masked.slice(start + 1, j + 1));
    }
  }
  const declRe = /\b(?:const|let|var)\b/g;
  while ((m = declRe.exec(masked))) {
    let j = m.index + m[0].length;
    let expectBinding = true;
    let depth = 0;
    while (j < masked.length) {
      const c = masked[j];
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') depth -= 1;
      else if (depth === 0 && (c === ';' || c === '\n' && /\s*\n/.test(masked.slice(j, j + 2)))) break;
      if (expectBinding && /[A-Za-z_$[]/.test(c)) {
        if (c === '[' || c === '{') {
          const end = balancedEnd(j);
          for (const token of identifierTokens(masked.slice(j + 1, end))) {
            if (!JS_NON_REFERENCES.has(token.name)) names.add(token.name);
          }
          j = end + 1;
        } else {
          const idRe = /[A-Za-z_$][A-Za-z0-9_$]*/;
          const id = idRe.exec(masked.slice(j));
          if (id) {
            names.add(id[0]);
            j += id[0].length;
          } else j += 1;
        }
        expectBinding = false;
        continue;
      }
      if (depth === 0 && c === ',') expectBinding = true;
      j += 1;
    }
  }
  return names;
}

function freeIdentifiers(combinedSource, fnSource) {
  const combined = maskSource(combinedSource);
  const scope = maskSource(fnSource);
  const declared = declaredNames(combined);
  return [...referencesIn(scope)].filter(name => !declared.has(name) && !PAGE_GLOBALS.has(name)).sort();
}

describe('in-page probe self-containment (D6 regression)', () => {
  test('every T4 probe serializes into a parsable kit-augmented function', async () => {
    const module = await import('./visual-redesign-scenarios-t4.mjs');
    const probes = [module.probeDagGraph, module.probeDenseViewport, module.probeDagList, module.probeShelfTabs, module.probeDagRunningMotion, module.probeT4RunningIndicators];
    for (const fn of probes) {
      expect(() => new Function(`${pageKit()}\nreturn (${fn.toString()})();`)).not.toThrow();
    }
  });
  test('no T4 probe references a name the page never receives', async () => {
    const module = await import('./visual-redesign-scenarios-t4.mjs');
    const probes = [module.probeDagGraph, module.probeDenseViewport, module.probeDagList, module.probeShelfTabs, module.probeDagRunningMotion, module.probeT4RunningIndicators];
    const kit = pageKit();
    for (const fn of probes) {
      const free = freeIdentifiers(`${kit}\n${fn.toString()}`, fn.toString());
      expect(free, `${fn.name || '(anonymous)'} leaks non-injected identifiers`).toEqual([]);
    }
  });
  test('probe bodies contain no module import syntax (serialized standalone)', async () => {
    const module = await import('./visual-redesign-scenarios-t4.mjs');
    for (const fn of [module.probeDagGraph, module.probeDenseViewport, module.probeDagList, module.probeShelfTabs, module.probeDagRunningMotion, module.probeT4RunningIndicators]) {
      expect(fn.toString()).not.toMatch(/\bimport\b|\bexport\b/);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Adversarial DOM fixtures (binding lead requirement): each scenario's
// ACTUAL serialized in-page probe - the same new Function(pageKit + source)
// construction the CLI evaluates in real Chrome - is executed against a
// controlled DOM that violates the scenario, and the driver-side verdicts
// must flip to fail; a conforming fixture must pass. The micro-DOM below
// implements exactly the selector/combinator subset the T4 probes use, so
// the probes are exercised as shipped, never re-implemented.
// ---------------------------------------------------------------------------

/** Selector subset used by the T4 probes: comma lists of compound
 * selectors (tag, .class, [attr], [attr="v"], [attr*="v" i], and compounds
 * of those), combined with descendant (space) and child (>) combinators. */
function parseCompound(part) {
  const tokens = part.match(/[A-Za-z][\w-]*|\.[\w-]+|\[[^\]]+\]/g) ?? [];
  const compound = { tag: null, classes: [], attrs: [] };
  for (const token of tokens) {
    if (token.startsWith('.')) compound.classes.push(token.slice(1));
    else if (token.startsWith('[')) {
      const match = /^\[\s*([\w-]+)\s*(?:([*^|$]?=)\s*(.*?)\s*)?\]$/.exec(token);
      if (!match) throw new Error(`bad attr selector ${token}`);
      let value = match[3] ?? '';
      let ci = false;
      const quoted = /^"(.*)"(?:\s+i)?$/i.exec(value);
      if (quoted) { value = quoted[1]; ci = /\s+i$|^".*"\s+i$/.test(match[3]); }
      else {
        const flagged = /^([^\s]+)\s+i$/i.exec(value);
        if (flagged) { value = flagged[1]; ci = true; }
      }
      if (/\s+i$/i.test(match[3] ?? '')) ci = true;
      compound.attrs.push({ name: match[1], op: match[2] ?? '', value, ci });
    } else if (!token.startsWith('[')) compound.tag = token;
  }
  return compound;
}

function matchCompound(element, compound) {
  if (compound.tag && element.tagName !== compound.tag.toUpperCase()) return false;
  const classes = String(element.className ?? '').split(/\s+/).filter(Boolean);
  for (const name of compound.classes) if (!classes.includes(name)) return false;
  for (const attr of compound.attrs) {
    const raw = element.getAttribute ? element.getAttribute(attr.name) : null;
    if (raw === null || raw === undefined) return false;
    const value = String(raw);
    if (!attr.op) continue;
    const expected = attr.ci ? attr.value.replace(/\s i$/, '') : attr.value;
    const actual = attr.ci || attr.op === '*=' ? value.toLowerCase() : value;
    const wanted = attr.ci || attr.op === '*=' ? expected.toLowerCase() : expected;
    if (attr.op === '=' && actual !== wanted) return false;
    if (attr.op === '*=' && !actual.includes(wanted)) return false;
  }
  return true;
}

/** Split one complex selector into combinators/compounds on whitespace
 * that is OUTSIDE attribute brackets (a `[class*="x" i]` flag space must
 * not split). */
function splitSelectorParts(part) {
  const parts = [];
  let current = '';
  let depth = 0;
  for (const c of part) {
    if (c === '[') depth += 1;
    if (c === ']') depth -= 1;
    if (depth === 0 && /\s/.test(c)) {
      if (current) parts.push(current);
      current = '';
    } else current += c;
  }
  if (current) parts.push(current);
  return parts.flatMap(chunk => (chunk === '>' ? ['>'] : chunk.startsWith('>') ? ['>', chunk.slice(1)] : [chunk]));
}

function selectorMatches(element, selector) {
  return selector.split(',').map(part => part.trim()).filter(Boolean).some(part => {
    const segments = splitSelectorParts(part);
    let target = element;
    let matched = true;
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      let segment = segments[i];
      let childCombinator = false;
      if (segment === '>') continue;
      if (segment.startsWith('>')) { childCombinator = true; segment = segment.slice(1).trim(); }
      if (!matchCompound(target, parseCompound(segment))) { matched = false; break; }
      if (i > 0) {
        const parent = target.parentElement;
        if (!parent) { matched = false; break; }
        if (childCombinator) target = parent;
        else {
          // Walk ancestors until one matches the remaining (leftward) selector.
          const rest = segments.slice(0, i).join(' ');
          let ancestor = parent;
          while (ancestor && !selectorMatches(ancestor, rest)) ancestor = ancestor.parentElement;
          if (!ancestor) { matched = false; break; }
          target = ancestor;
          break;
        }
      }
    }
    return matched;
  });
}

function collectAll(root) {
  const out = [];
  const walk = node => {
    for (const child of node.children ?? []) { out.push(child); walk(child); }
  };
  if (root.nodeType === 9) walk(root.documentElement);
  else walk(root);
  return out;
}

function buildDom(tree) {
  const make = node => {
    const [tag, attrs = {}, options = {}] = node;
    const children = (options.children ?? []).map(make);
    const element = {
      tagName: tag.toUpperCase(), nodeType: 1,
      id: attrs.id ?? '', className: attrs.class ?? '',
      attrs: new Map(Object.entries(attrs)),
      children, parentElement: null,
      tabIndex: attrs.tabindex !== undefined ? Number(attrs.tabindex) : -1,
      getClientRects: () => [{ left: 0, top: 0, right: 1, bottom: 1, width: 1, height: 1 }],
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 1, bottom: 1, width: 1, height: 1 }),
      getAnimations: () => [],
      ...options.host || {},
    };
    element.getAttribute = name => (element.attrs.has(name) ? element.attrs.get(name) : null);
    element.setAttribute = (name, value) => { element.attrs.set(name, String(value)); };
    element.getAttributeNames = () => [...element.attrs.keys()];
    element.contains = other => {
      for (let node = other; node; node = node.parentElement) if (node === element) return true;
      return false;
    };
    element.matches = selector => selectorMatches(element, selector);
    element.closest = selector => {
      for (let current = element; current; current = current.parentElement) {
        if (selectorMatches(current, selector)) return current;
      }
      return null;
    };
    element.querySelector = selector => element.querySelectorAll(selector)[0] ?? null;
    element.querySelectorAll = selector => collectAll(element).filter(candidate => selectorMatches(candidate, selector));
    Object.defineProperty(element, 'textContent', {
      get() {
        const own = element.attrs.get('#text') ?? '';
        return own + children.map(child => child.textContent).join('');
      },
    });
    for (const child of children) child.parentElement = element;
    return element;
  };
  const root = make(tree);
  const documentElement = root;
  const document = {
    nodeType: 9, documentElement,
    querySelector: selector => collectAll({ children: [root] }).find(candidate => selectorMatches(candidate, selector)) ?? null,
    querySelectorAll: selector => collectAll({ children: [root] }).filter(candidate => selectorMatches(candidate, selector)),
  };
  return { root, document, documentElement };
}

const HIDDEN = 'display: none';

/** Run the ACTUAL serialized probe (kit + function source) with the fake
 * DOM installed as the page globals; originals are restored after. */
async function runProbe(fn, arg, dom, computed) {
  const source = `${pageKit()}\nreturn (${fn.toString()})(${JSON.stringify(arg ?? {})});`;
  const executable = new Function(source);
  const saved = {};
  const globals = { document: dom.document, getComputedStyle: computed,
    window: { innerWidth: 1280, innerHeight: 900, scrollX: 0, scrollY: 0 }, Element: Object };
  try {
    for (const [name, value] of Object.entries(globals)) {
      saved[name] = globalThis[name];
      globalThis[name] = value;
    }
    return await executable();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
}

const computedFromStyles = styles => element => {
  const inline = {};
  for (const pair of String(element.attrs.get('style') ?? '').split(';')) {
    const [property, ...rest] = pair.split(':');
    if (!property || !rest.length) continue;
    const camel = property.trim().startsWith('--') ? property.trim()
      : property.trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    inline[camel] = rest.join(':').trim();
  }
  const style = {
    display: 'block', visibility: 'visible', opacity: '1', transform: 'none', content: 'none',
    '--th-success': '#16a34a', '--th-warning': '#d97706', '--th-error': '#dc2626', '--th-accent': '#8b7cf6',
    '--th-font-mono': '"JetBrains Mono", ui-monospace, monospace',
    '--th-font-sans': '"Pretendard Variable", sans-serif',
    ...(styles?.(element) ?? {}), ...inline,
  };
  return new Proxy(style, { get: (target, property) => (property === 'getPropertyValue' ? name => target[name] ?? '' : target[property]) });
};

const clientRectOf = (x, y, width, height) => ({ left: x, top: y, right: x + width, bottom: y + height, width, height });

function withBox(element, x, y, width, height) {
  element.getBoundingClientRect = () => clientRectOf(x, y, width, height);
  element.getClientRects = () => [element.getBoundingClientRect()];
  return element;
}

function withAnimations(element, animations) {
  element.getAnimations = () => animations.map(({ playState = 'running', iterations = Infinity, name = 'th-fake' } = {}) => ({
    playState, kind: 'animation',
    effect: { getComputedTiming: () => ({ iterations }), getKeyframes: () => ({ [name]: true }) },
  }));
  return element;
}

const spin = () => ({ name: 'th-dag-run-spin', iterations: Infinity });
const cometLoop = () => ({ name: 'th-dag-comet', iterations: Infinity });

// ----- S13: shelf tabs through the ACTUAL serialized probeShelfTabs ------

describe('S13 adversarial + conforming fixtures via the serialized probeShelfTabs', () => {
  const tabTree = (thumb, countFamily) => ['div', { class: 'th-activity-tabs', role: 'tablist' }, {
    children: [
      ...(thumb ? [['div', { class: 'th-activity-tab-thumb', 'data-thumb': 'true', style: 'background-color: #25262b' }]] : []),
      ['button', { class: 'th-activity-tab', 'data-activity-tab': 'todo', role: 'tab', 'aria-selected': 'true', tabindex: '0' }, { children: [
        ['span', { class: 'th-activity-tab-label', '#text': 'Todo' }],
        ['span', { class: 'th-activity-tab-count', style: `font-family: ${countFamily}`, '#text': '0/3' }],
      ] }],
      ['button', { class: 'th-activity-tab', 'data-activity-tab': 'agents', role: 'tab', 'aria-selected': 'false', tabindex: '-1' }, { children: [
        ['span', { class: 'th-activity-tab-label', '#text': 'Subagents' }],
        ['span', { class: 'th-activity-tab-count', style: `font-family: ${countFamily}`, '#text': '0/18' }],
      ] }],
      ['button', { class: 'th-activity-tab', 'data-activity-tab': 'dag', role: 'tab', 'aria-selected': 'false', tabindex: '-1' }, { children: [
        ['span', { class: 'th-activity-tab-label', '#text': 'DAG' }],
        ['span', { class: 'th-activity-tab-count', style: `font-family: ${countFamily}`, '#text': '1/1' }],
      ] }],
    ],
  }];
  const layout = (dom, thumbX = 2) => {
    const tabs = dom.document.querySelectorAll('[role="tab"]');
    tabs.forEach((tab, index) => withBox(tab, index * 104, 0, 100, 32));
    const thumb = dom.document.querySelector('[data-thumb]');
    if (thumb) withBox(thumb, thumbX, 2, 96, 28);
    return tabs;
  };
  const measure = (tree, thumbTransform, thumbX = 2, existingDom = null) => {
    const dom = existingDom ?? buildDom(tree);
    layout(dom, thumbX);
    const computed = computedFromStyles(element => (element.attrs.has('data-thumb') && thumbTransform ? { transform: thumbTransform } : {}));
    return runProbe(probeShelfTabs, null, dom, computed);
  };

  test('adversarial baseline (boxed tabs, mono counts, no thumb) FAILS', async () => {
    const facts = await measure(tabTree(false, '"JetBrains Mono", monospace'));
    expect(facts.found).toBe(true);
    expect(facts.thumb.found).toBe(false);
    expect(thumbVerdict(facts, facts).pass).toBe(false);
    expect(countFontVerdict(facts.tabs, firstFamily(facts.monoToken)).pass).toBe(false);
  });
  test('conforming segmented control (thumb moves + sans counts) PASSES', async () => {
    const dom = buildDom(tabTree(true, '"Pretendard Variable", sans-serif'));
    const factsA = await measure(null, 'matrix(1, 0, 0, 1, 0, 0)', 2, dom);
    // A real switch moves the thumb box with the transform: agents is the
    // second segment, so the rect moves to x=106 alongside translateX(104).
    const factsB = await measure(null, 'matrix(1, 0, 0, 1, 104, 0)', 106, dom);
    // factsB re-presents the agents tab as selected, as a real switch would.
    factsB.selectedId = 'agents';
    factsB.tabs[0].selected = false;
    factsB.tabs[1].selected = true;
    expect(thumbVerdict(factsA, factsB).pass).toBe(true);
    expect(countFontVerdict(factsB.tabs, firstFamily(factsB.monoToken)).pass).toBe(true);
  });
  test('duplicate, transparent and replaced serialized thumbs fail', async () => {
    const dom = buildDom(tabTree(true, '"Pretendard Variable", sans-serif'));
    const before = await measure(null, 'matrix(1, 0, 0, 1, 0, 0)', 2, dom);
    const original = dom.document.querySelector('[data-thumb]');
    const after = async () => {
      const facts = await measure(null, 'matrix(1, 0, 0, 1, 104, 0)', 106, dom);
      facts.selectedId = 'agents';
      return facts;
    };
    const duplicate = buildDom(tabTree(true, '"Pretendard Variable", sans-serif'));
    duplicate.root.children.splice(1, 0, buildDom(['span', { class: 'th-activity-tab-thumb' }]).root);
    duplicate.root.children[1].parentElement = duplicate.root;
    expect(thumbVerdict(before, await measure(null, 'matrix(1, 0, 0, 1, 104, 0)', 106, duplicate)).pass).toBe(false);
    original.attrs.set('style', 'background-color: transparent');
    expect(thumbVerdict(before, await after()).pass).toBe(false);
    original.attrs.set('style', 'background-color: #25262b');
    original.attrs.delete('data-qa-thumb-id');
    // The next probe marks the replacement with a fresh identity.
    expect(thumbVerdict(before, await after()).pass).toBe(false);
  });
});

// ----- S8: running glyph through the ACTUAL serialized probeDagRunningMotion

describe('S8 adversarial + conforming fixtures via the serialized probeDagRunningMotion', () => {
  const motionTree = (glyphStyle, withStateWord, animated) => ['div', { class: 'th-activity-graph' }, {
    children: [
      ['svg', {}, { children: [
        ['g', { class: 'th-activity-gnode th-activity-gnode--running', 'data-node': 'k6' }, { children: [
          ['circle', { class: 'th-activity-gstatus th-activity-gstatus--running', style: glyphStyle }],
          ['text', { class: 'th-activity-gstate', '#text': withStateWord ? 'Running' : '' }],
        ] }],
      ] }],
    ],
  }];
  const measure = async tree => {
    const dom = buildDom(tree);
    const glyph = dom.document.querySelector('.th-activity-gstatus--running');
    withBox(glyph, 10, 10, 8, 8);
    return { dom, facts: await runProbe(probeDagRunningMotion, null, dom, computedFromStyles()) };
  };

  test('adversarial baseline (amber glyph, spinning under reduced motion) FAILS', async () => {
    const { facts } = await measure(motionTree('color: rgb(217, 119, 6); stroke: currentColor', true, true));
    expect(facts.runningGlyphs).toHaveLength(1);
    expect(dagGlyphAccentVerdict(facts, '#8b7cf6').pass).toBe(false);
    // Under reduced motion the same facts must also fail when anything still spins.
    expect(dagReducedMotionVerdict(facts).pass).toBe(true); // state word present, nothing reported animated yet
  });
  test('adversarial reduced motion (accent glyph still spinning, no word) FAILS', async () => {
    const { dom, facts } = await measure(motionTree('color: rgb(139, 124, 246); stroke: currentColor', false, true));
    const glyph = dom.document.querySelector('.th-activity-gstatus--running');
    withAnimations(glyph, [spin()]);
    const animated = await runProbe(probeDagRunningMotion, null, dom, computedFromStyles());
    expect(animated.runningGlyphs[0].runningAnimations).toBe(1);
    expect(dagReducedMotionVerdict(animated).pass).toBe(false);
    expect(dagGlyphAccentVerdict(facts, '#8b7cf6').pass).toBe(true);
    expect(dagRunningMotionVerdict(animated).pass).toBe(true);
  });
});


// ----- S8 scope: ACTUAL serialized probeT4RunningIndicators on adversarial DOM

describe('T4 S8 scope via the serialized probeT4RunningIndicators', () => {
  const ACCENT = '#8b7cf6';
  const DIM = '#c4c4cc';
  const glyph = (stroke) => ['g', { class: 'th-activity-gnode th-activity-gnode--running', 'data-node': 'k6', style: `stroke: ${stroke}` }, { children: [
    ['circle', { class: 'th-activity-gstatus th-activity-gstatus--running', style: `stroke: ${stroke}` }],
  ] }];
  const shelf = ({ stroke = ACCENT, transcript = false, treeDot = false, statusWord = false } = {}) => ['div', { id: 'page' }, { children: [
    ...(transcript ? [['section', { class: 'th-chat-transcript' }, { children: [
      ['span', { class: 'th-tool-glyph th-tool-glyph--running', style: `color: ${DIM}; background-color: #000000; border-top-color: #000000; fill: #000000` }],
      ['circle', { class: 'th-activity-gstatus th-activity-gstatus--running', style: `stroke: ${DIM}` }],
    ] }]] : []),
    ...(treeDot ? [['span', { class: 'th-tree-running-dot', style: `background-color: ${DIM}` }]] : []),
    ['div', { class: 'th-activity-shelf' }, { children: [
      ['div', { class: 'th-activity-dag-head' }, { children: [
        ['span', { class: 'th-activity-chip th-activity-chip--running', style: 'background-color: #3f3f46; color: #ededf0', '#text': 'Running' }],
        ['div', { class: 'th-activity-dag-progress', 'data-live': 'true' }, { children: [
          ['span', { class: 'th-activity-dag-progress-fill', style: `background-color: ${stroke}` }],
        ] }],
      ] }],
      ['div', { class: 'th-activity-graph' }, { children: [
        ['svg', {}, { children: [glyph(stroke)] }],
      ] }],
      ['ul', { class: 'th-activity-dagnodes' }, { children: [
        ['li', { class: 'th-activity-dnode th-activity-dnode--running' }, { children: [
          ['circle', { class: 'th-activity-gstatus th-activity-gstatus--running', style: `stroke: ${stroke}` }],
          ['span', { class: 'th-activity-dnode-state', '#text': 'running' }],
        ] }],
      ] }],
      ['span', { class: 'th-activity-glyph th-activity-glyph--running', style: `background-color: ${stroke}` }],
      ...(statusWord ? [['span', { role: 'status', '#text': 'Running' }]] : []),
    ] }],
  ] }];
  const measure = async (tree, phase = 'accent') => {
    const dom = buildDom(tree);
    return runProbe(probeT4RunningIndicators, { phase }, dom, computedFromStyles());
  };

  test('a non-accent running DAG node fails', async () => {
    const result = await measure(['div', { class: 'th-activity-shelf' }, { children: [
      ['div', { class: 'th-activity-graph' }, { children: [
        ['svg', {}, { children: [glyph(DIM)] }],
      ] }],
    ] }]);
    expect(result.pass).toBe(false);
    expect(result.measurements.inScopeCount).toBe(2);
    expect(result.failures.length).toBeGreaterThan(0);
    for (const failure of result.failures) {
      expect(failure).toContain('not accent-coloured');
      expect(failure).not.toContain('th-tool-glyph');
    }
    expect(result.measurements.glyphs.every(glyphFact => glyphFact.matchesAccent === false)).toBe(true);
  });

  test('an accent running DAG node passes, including list row, run header, and shelf glyph', async () => {
    const result = await measure(shelf());
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.measurements.scope).toBe('activity-shelf-dag');
    expect(result.measurements.inScopeCount).toBe(5);
    expect(result.measurements.glyphs.every(glyphFact => glyphFact.matchesAccent === true)).toBe(true);
    const selectors = result.measurements.glyphs.map(glyphFact => glyphFact.selector);
    expect(selectors).toContain('.th-activity-gnode--running');
    expect(selectors).toContain('.th-activity-gstatus--running');
    expect(selectors).toContain('.th-activity-glyph--running');
    expect(selectors).toContain('.th-activity-dag-progress[data-live="true"] .th-activity-dag-progress-fill');
    // The run-header status chip is a wash, not the accent ink, and is not judged.
    expect(selectors).not.toContain('.th-activity-chip--running');
    expect(result.measurements.excludedCounts).toEqual({});
  });

  test('a non-accent transcript tool glyph is ignored by T4 S8', async () => {
    const result = await measure(shelf({ transcript: true, treeDot: true }));
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.failures.join('\n')).not.toContain('th-tool-glyph');
    expect(result.measurements.inScopeCount).toBe(5);
    expect(result.measurements.glyphs.every(glyphFact => glyphFact.matchesAccent === true)).toBe(true);
    expect(result.measurements.excludedSelectors).toContain('.th-tool-glyph');
    expect(result.measurements.excludedSelectors).toContain('.th-chat-transcript');
    expect(result.measurements.excludedSelectors).toContain('.th-tool-glyph--running');
    expect(result.measurements.excludedCounts['.th-tool-glyph']).toBe(1);
    expect(result.measurements.excludedCounts['.th-tool-glyph--running']).toBe(1);
    // Tool glyph plus the dim DAG glyph planted inside the transcript.
    expect(result.measurements.excludedCounts['.th-chat-transcript']).toBe(2);
    expect(result.measurements.excludedCounts['.th-tree-running-dot']).toBe(1);
    expect(result.measurements.glyphs.some(glyphFact => glyphFact.selector.includes('tool-glyph'))).toBe(false);
  });

  test('reduced motion ignores a spinning transcript tool glyph and fails a spinning DAG glyph', async () => {
    const calmDom = buildDom(shelf({ transcript: true, statusWord: true }));
    const tool = calmDom.document.querySelector('.th-tool-glyph--running');
    withAnimations(tool, [spin()]);
    const calm = await runProbe(probeT4RunningIndicators, { phase: 'reduced' }, calmDom, computedFromStyles());
    expect(calm.pass).toBe(true);
    expect(calm.failures.join('\n')).not.toContain('th-tool-glyph');
    expect(calm.measurements.excludedCounts['.th-chat-transcript']).toBeGreaterThan(0);

    const spinningDom = buildDom(shelf({ statusWord: true }));
    const dagGlyph = spinningDom.document.querySelector('.th-activity-graph .th-activity-gstatus--running');
    withAnimations(dagGlyph, [spin()]);
    const spinning = await runProbe(probeT4RunningIndicators, { phase: 'reduced' }, spinningDom, computedFromStyles());
    expect(spinning.pass).toBe(false);
    expect(spinning.failures.some(failure => failure.includes('still animates'))).toBe(true);
  });

  test('driveS8 measures the scoped probe rather than the shared glyph census', () => {
    const source = scenarios.S8.toString();
    expect(source).toContain('probeT4RunningIndicators');
    expect(source).not.toContain('probeRunningGlyphs');
    expect(source).not.toContain('probeRunningReducedMotion');
  });
});

// ----- S14: DAG graph through the ACTUAL serialized probeDagGraph ---------

describe('S14 adversarial + conforming fixtures via the serialized probeDagGraph', () => {
  const node = (id, state, stroke, glyphLeft, wave) => ['g', { class: `th-activity-gnode th-activity-gnode--${state}`, 'data-node': id }, {
    host: {
      getAttribute: null, // set by buildDom
      transform: `translate(${wave * 164 + 6}, 6)`,
    },
    children: [
      ['rect', { class: 'th-activity-gnode-card', style: `stroke: ${stroke}`, width: 160, height: 60 }],
      ['text', { class: 'th-activity-glabel', '#text': `label ${id}` }],
      ['text', { class: 'th-activity-gstate', '#text': state }],
      ...(state === 'muted' ? [] : [['circle', { class: `th-activity-gstatus th-activity-gstatus--${state}` }]]),
    ],
  }];
  const graphTree = ({ redesigned }) => ['div', { class: 'th-activity-graph', style: 'overflow-x: auto' }, {
    host: { scrollLeft: redesigned ? 700 : 0, scrollWidth: 1800, clientWidth: 700 },
    children: [
      ['svg', {}, {
        host: { viewBox: undefined },
        children: [
          ['defs', {}, { children: [['marker', { id: 'arrow' }, { children: [['path', { class: 'th-activity-gedge-head', d: 'M0,0L8,3L0,6Z' }]] }]] }],

          redesigned
            ? ['path', { class: 'th-activity-gedge th-activity-gedge--flow', d: 'M166 36 C 190 36, 210 36, 234 36' }]
            : ['line', { class: 'th-activity-gedge', x1: 166, y1: 36, x2: 234, y2: 36 }],
          redesigned ? ['circle', { class: 'th-dag-comet' }] : null,
          ['g', { class: 'th-activity-gnode th-activity-gnode--running', 'data-node': 'k6' }, {
            host: { transform: 'translate(1030, 6)' },
            children: [
              ...(redesigned ? [['rect', { class: 'th-activity-gnode-halo', style: 'stroke: none' }]] : []),
              ['rect', { class: 'th-activity-gnode-card', style: `stroke: ${redesigned ? 'rgba(255,255,255,0.06)' : 'rgb(217, 119, 6)'}` }],
              ['text', { class: 'th-activity-glabel', '#text': 'label k6' }],
              ['text', { class: 'th-activity-gstate', '#text': 'running' }],
              ['circle', { class: 'th-activity-gstatus th-activity-gstatus--running' }],
            ],
          }],
          node('k0', 'ok', redesigned ? 'rgba(255,255,255,0.06)' : 'rgb(22, 163, 74)', true, 0),
        ].filter(Boolean),
      }],
      ['div', { class: 'th-activity-dag-head' }, {
        children: redesigned ? [
          ['span', { class: 'th-activity-dag-name', '#text': 'run' }],
          ['span', { class: 'th-activity-dag-counts', '#text': '6/11 done' }],
          ['div', { class: 'th-activity-dag-progress', role: 'progressbar', 'aria-valuenow': '7', 'aria-valuemax': '11' }, {
            children: [['div', { class: 'th-activity-dag-progress-fill', style: 'transform: matrix(0.545455, 0, 0, 1, 0, 0)' }]],
          }],
        ] : [['span', { class: 'th-activity-dag-name', '#text': 'run' }], ['span', { class: 'th-activity-dag-counts', '#text': '6/11' }]],
      }],
    ],
  }];
  const measure = async redesigned => {
    const dom = buildDom(graphTree({ redesigned }));
    // Geometry: label/glyph boxes make the glyph-left redesign visible. In
    // the conforming (scrolled) view the running node sits beside the
    // flowing edge; in the adversarial baseline it never entered the reel.
    const k6X = redesigned ? 280 : 1030;
    for (const group of dom.document.querySelectorAll('[data-node]')) {
      const id = group.getAttribute('data-node');
      const x = id === 'k6' ? k6X : 6;
      withBox(group, x, 6, 160, 60);
      const glyph = group.querySelector('[class*="gstatus" i]');
      if (glyph) withBox(glyph, redesigned ? x + 8 : x + 140, 12, 10, 10);
      const label = group.querySelector('text[class*="glabel" i]');
      if (label) withBox(label, x + 26, 10, 60, 12);
      for (const box of group.querySelectorAll('rect')) withBox(box, x, 6, 160, 60);
    }
    // Edge geometry must land on the REAL edge (defs/marker paths also
    // match the [class*="gedge"] census but are excluded by the probe).
    for (const edgeElement of dom.document.querySelectorAll('[class*="gedge" i]')) {
      if (edgeElement.closest('marker, defs')) continue;
      withBox(edgeElement, 166, 26, 68, 20);
      edgeElement.getTotalLength = () => 68;
      edgeElement.getPointAtLength = at => (at === 0 ? { x: 166, y: 36 } : { x: 234, y: 36 });
    }
    const head = dom.document.querySelector('.th-activity-dag-head');
    withBox(head, 0, 80, 700, 24);
    const progress = head.querySelector('[role="progressbar"]');
    if (progress) {
      withBox(progress, 0, 82, 690, 4);
      withBox(progress.children[0], 0, 82, 690, 4);
      progress.children[0].style = { transform: `scaleX(${6 / 11})` };
    }
    const comet = dom.document.querySelector('[class*="comet" i]');
    if (comet) { withBox(comet, 180, 28, 12, 12); withAnimations(comet, [cometLoop()]); }
    const halo = dom.document.querySelector('[class*="halo" i]');
    if (halo) withBox(halo, k6X - 5, 1, 170, 70);
    const glyph = dom.document.querySelector('.th-activity-gstatus--running');
    if (glyph) withAnimations(glyph, [spin()]);
    const graphHost = dom.root;
    withBox(graphHost, 0, 0, 700, 300);
    return runProbe(probeDagGraph, { runningId: 'k6', sourceId: 'k0' }, dom, computedFromStyles());
  };

  test('adversarial baseline graph FAILS every T4-owed assertion', async () => {
    const facts = await measure(false);
    expect(facts.found).toBe(true);
    const sourceRect = facts.nodes.find(n => n.id === 'k0')?.rect ?? null;
    expect(edgeShapeVerdict(facts.edges).pass).toBe(false);
    expect(nodeStrokeViolations(facts.nodes, facts.tokens).pass).toBe(false);
    expect(glyphOrderVerdict(facts.nodes).pass).toBe(false);
    expect(cometVerdict(facts.comets, findRunningEdge(facts.edges, sourceRect, facts.runningRect)).pass).toBe(false);
    expect(haloVerdict(facts.halos, facts.runningRect).pass).toBe(false);
    expect(progressVerdict(facts.progress.map(f => ({ ...f, scaleX: scaleXFromTransform(f.transform), inlineScaleX: scaleXFromTransform(f.inlineTransform) })), 6 / 11).pass).toBe(false);
    expect(autoScrollVerdict({ scroller: facts.scroller, runningRect: facts.runningRect }).pass).toBe(false);
  });
  test('conforming redesigned graph PASSES every T4-owed assertion', async () => {
    const facts = await measure(true);
    expect(facts.found).toBe(true);
    const sourceRect = facts.nodes.find(n => n.id === 'k0')?.rect ?? null;
    const runningEdge = findRunningEdge(facts.edges, sourceRect, facts.runningRect);
    expect(edgeShapeVerdict(facts.edges).pass).toBe(true);
    expect(nodeStrokeViolations(facts.nodes, facts.tokens).pass).toBe(true);
    expect(glyphOrderVerdict(facts.nodes).pass).toBe(true);
    expect(cometVerdict(facts.comets, runningEdge).pass).toBe(true);
    expect(haloVerdict(facts.halos, facts.runningRect).pass).toBe(true);
    expect(progressVerdict(facts.progress.map(f => ({ ...f, scaleX: scaleXFromTransform(f.transform), inlineScaleX: scaleXFromTransform(f.inlineTransform) })), 6 / 11).pass).toBe(true);
    expect(facts.progress[0].countText).toBe('6/11 done');
    expect(progressVerdict(facts.progress.map(f => ({
      ...f, scaleX: scaleXFromTransform(f.transform), inlineScaleX: scaleXFromTransform(f.inlineTransform),
    })), 6 / 11, '6/11').pass).toBe(true);
    expect(autoScrollVerdict({ scroller: facts.scroller, runningRect: facts.runningRect }).pass).toBe(true);
  });
  test('running card behind the halo is measured and a missing card fails', async () => {
    for (const stroke of ['#8b7cf6', '#d97706']) {
      const dom = buildDom(graphTree({ redesigned: true }));
      dom.document.querySelector('.th-activity-dag-progress-fill').style = { transform: `scaleX(${6 / 11})` };
      const card = dom.document.querySelector('[data-node="k6"] .th-activity-gnode-card');
      card.attrs.set('style', `stroke: ${stroke}`);
      const facts = await runProbe(probeDagGraph, { runningId: 'k6' }, dom, computedFromStyles());
      expect(facts.nodes.find(nodeFact => nodeFact.id === 'k6').stroke).toBe(stroke);
      expect(nodeStrokeViolations(facts.nodes, facts.tokens).pass).toBe(false);
    }
    const dom = buildDom(graphTree({ redesigned: true }));
    dom.document.querySelector('.th-activity-dag-progress-fill').style = { transform: `scaleX(${6 / 11})` };
    const removed = dom.document.querySelector('[data-node="k6"] .th-activity-gnode-card');
    removed.attrs.set('class', 'removed-card');
    removed.className = 'removed-card';
    const facts = await runProbe(probeDagGraph, { runningId: 'k6' }, dom, computedFromStyles());
    expect(facts.nodes.find(nodeFact => nodeFact.id === 'k6').cardFound).toBe(false);
    expect(nodeStrokeViolations(facts.nodes, facts.tokens).pass).toBe(false);
  });
  test('a correct computed scale cannot hide a wrong inline progress target', async () => {
    const dom = buildDom(graphTree({ redesigned: true }));
    const fill = dom.document.querySelector('.th-activity-dag-progress-fill');
    fill.attrs.set('style', 'transform: matrix(0.545455, 0, 0, 1, 0, 0)');
    fill.style = { transform: 'scaleX(0.636364)' };
    const facts = await runProbe(probeDagGraph, { runningId: 'k6', sourceId: 'k0' }, dom, computedFromStyles());
    const verdict = progressVerdict(facts.progress.map(fact => ({
      found: fact.found, where: fact.where,
      settled: fact.settled, scaleX: scaleXFromTransform(fact.transform),
      inlineScaleX: scaleXFromTransform(fact.inlineTransform),
    })), 6 / 11);
    expect(verdict.pass).toBe(false);
  });
  test('serialized graph probe measures progress after the fill transition finishes', async () => {
    const dom = buildDom(graphTree({ redesigned: true }));
    const fill = dom.document.querySelector('.th-activity-dag-progress-fill');
    fill.style = { transform: `scaleX(${6 / 11})` };
    fill.attrs.set('style', 'transform: matrix(0.2, 0, 0, 1, 0, 0)');
    let resolveFinished;
    const finished = new Promise(resolve => { resolveFinished = resolve; });
    let observeAnimation;
    const observed = new Promise(resolve => { observeAnimation = resolve; });
    const animation = { playState: 'running', finished };
    fill.getAnimations = () => { observeAnimation(); return animation.playState === 'running' ? [animation] : []; };

    const pending = runProbe(probeDagGraph, { runningId: 'k6', sourceId: 'k0' }, dom, computedFromStyles());
    await observed;
    fill.attrs.set('style', 'transform: matrix(0.545455, 0, 0, 1, 0, 0)');
    animation.playState = 'finished';
    resolveFinished();
    const facts = await pending;
    const verdict = progressVerdict(facts.progress.map(fact => ({
      found: fact.found, where: fact.where, settled: fact.settled,
      scaleX: scaleXFromTransform(fact.transform), inlineScaleX: scaleXFromTransform(fact.inlineTransform),
    })), 6 / 11);
    expect(verdict.pass).toBe(true);
  });
});

describe('S14 dense bottom boundary via the serialized viewport probe', () => {
  const denseTree = () => ['div', { class: 'th-activity-shelf',
    style: 'overflow-y: hidden; mask-image: linear-gradient(to top, transparent, black 24px)' }, { children: [
    ['div', { class: 'th-activity-graph', style: 'overflow-y: hidden' }, { children: [
      ['svg', {}, { children: [
        ['g', { class: 'th-activity-gnode', 'data-node': 'row-3' }],
      ] }],
    ] }],
  ] }];
  const measure = async dom => {
    withBox(dom.root, 0, 0, 700, 220);
    const graph = withBox(dom.document.querySelector('.th-activity-graph'), 0, 40, 700, 660);
    withBox(graph.querySelector('svg'), 0, 40, 700, 660);
    withBox(dom.document.querySelector('[data-node]'), 10, 200, 160, 60);
    return runProbe(probeDenseViewport, null, dom, computedFromStyles());
  };
  test('an ancestor fade at the actual clipped row passes, with bounds and mask recorded', async () => {
    const facts = await measure(buildDom(denseTree()));
    expect(facts.graph.rect.bottom).toBe(700);
    expect(facts.visibleBottom).toBe(220);
    expect(facts.clippingAncestors[0].rect.bottom).toBe(220);
    expect(facts.clippingAncestors[0].maskImage).toContain('linear-gradient');
    expect(facts.partialNodes).toEqual(['row-3']);
    expect(denseFadeVerdict(facts).pass).toBe(true);
  });
  test('removing the fade or painting it on the full-height graph fails', async () => {
    const dom = buildDom(denseTree());
    dom.root.attrs.set('style', 'overflow-y: hidden');
    const bare = await measure(dom);
    expect(bare.bottomFade).toBe(false);
    expect(denseFadeVerdict(bare).pass).toBe(false);
    dom.document.querySelector('.th-activity-graph').attrs.set('style',
      'overflow-y: hidden; mask-image: linear-gradient(to top, transparent, black 24px)');
    const wrongBoundary = await measure(dom);
    expect(wrongBoundary.bottomFade).toBe(false);
    expect(denseFadeVerdict(wrongBoundary).pass).toBe(false);
  });
  test('a lifted graph mask passes only when its transparent stop matches the clipping edge', async () => {
    const dom = buildDom(denseTree());
    dom.root.attrs.set('style', 'overflow-y: hidden');
    const graph = dom.document.querySelector('.th-activity-graph');
    graph.attrs.set('data-fade-bottom', 'true');
    graph.attrs.set('style', 'overflow-y: hidden; --dag-fade-lift: 480px; mask-image: linear-gradient(to top, transparent 480px, black 504px)');
    expect(denseFadeVerdict(await measure(dom)).pass).toBe(true);
    graph.attrs.set('style', 'overflow-y: hidden; --dag-fade-lift: 440px; mask-image: linear-gradient(to top, transparent 440px, black 464px)');
    expect(denseFadeVerdict(await measure(dom)).pass).toBe(false);
    graph.attrs.set('style', 'overflow-y: hidden; --dag-fade-lift: 480px; mask-image: none');
    expect(denseFadeVerdict(await measure(dom)).pass).toBe(false);
  });
});

// ----- S14 list view through the ACTUAL serialized probeDagList -----------

describe('S14 list view via the serialized probeDagList', () => {
  const railNode = () => ['span', { class: 'th-activity-dnode-rail' }, {
    children: [['svg', {}, { children: [['circle', { class: 'th-activity-gstatus' }]] }]],
  }];
  const listTree = railed => ['div', { 'data-activity-tabpanel': 'dag' }, {
    children: [
      ['div', { class: 'th-activity-dag-view', 'data-view-mode': 'list' }, { children: [
        ['button', { 'data-view': 'list', 'aria-pressed': 'true' }],
        ['button', { 'data-view': 'graph', 'aria-pressed': 'false' }],
      ] }],
      ['ul', { class: 'th-activity-dagnodes' }, {
        children: [
          ['li', { class: 'th-activity-dnode' }, {
            children: [
              ...(railed ? [railNode()] : []),
              ['span', { class: 'th-activity-dnode-label', '#text': 'node k0' }],
            ],
          }],
          ['li', { class: 'th-activity-dnode' }, {
            children: [
              ...(railed ? [railNode()] : []),
              ['span', { class: 'th-activity-dnode-label', '#text': 'node k6' }],
            ],
          }],
        ],
      }],
    ],
  }];
  const measure = (railed, railColor = 'rgba(255,255,255,0.2)', options = {}) => {
    const dom = buildDom(listTree(railed));
    if (options.ancestorStyle) dom.root.attrs.set('style', options.ancestorStyle);
    dom.document.querySelectorAll('li').forEach((row, index) => withBox(row, 8, index * 40, 690, 32));
    dom.document.querySelectorAll('[class*="rail" i]').forEach(rail => {
      withBox(rail, 8, 0, 2, 32);
      if (options.railStyle) rail.attrs.set('style', options.railStyle);
    });
    const normal = computedFromStyles();
    const computed = (element, pseudo) => pseudo
      ? { content: '""', width: '1px', height: '16px', backgroundColor: railColor, opacity: '1',
        display: 'block', visibility: 'visible', ...options.pseudo }
      : normal(element);
    return runProbe(probeDagList, null, dom, computed);
  };
  test('plain baseline list rows FAIL the rail verdict', async () => {
    const facts = await measure(false);
    expect(facts.found).toBe(true);
    expect(facts.rows).toHaveLength(2);
    expect(railVerdict(facts.rows, facts.viewMode).pass).toBe(false);
  });
  test('railed timeline rows PASS the rail verdict', async () => {
    const facts = await measure(true);
    expect(facts.viewMode).toBe('list'); // inline SVG status glyphs are not a graph.
    expect(railVerdict(facts.rows, facts.viewMode).pass).toBe(true);
  });
  test('class-only unpainted rail and selected Graph mode fail', async () => {
    const invisible = await measure(true, 'transparent');
    expect(invisible.rows[0].segments).toHaveLength(2);
    expect(railVerdict(invisible.rows, invisible.viewMode).pass).toBe(false);
    const graph = buildDom(listTree(true));
    graph.document.querySelector('[data-view-mode]').attrs.set('data-view-mode', 'graph');
    graph.document.querySelector('[data-view="list"]').attrs.set('aria-pressed', 'false');
    graph.document.querySelector('[data-view="graph"]').attrs.set('aria-pressed', 'true');
    const facts = await runProbe(probeDagList, null, graph, (element, pseudo) => pseudo
      ? { content: '""', width: '1px', height: '16px', backgroundColor: '#ffffff', opacity: '1' }
      : computedFromStyles()(element));
    expect(facts.viewMode).toBe('graph');
    expect(railVerdict(facts.rows, facts.viewMode).pass).toBe(false);
  });
  test('zero-opacity, hidden pseudo paint and transparent ancestors fail the serialized rail verdict', async () => {
    for (const options of [
      { pseudo: { opacity: '0' } },
      { pseudo: { display: 'none' } },
      { pseudo: { visibility: 'hidden' } },
      { pseudo: { content: 'none' } },
      { railStyle: 'opacity: 0' },
      { ancestorStyle: 'opacity: 0' },
      { ancestorStyle: 'visibility: hidden' },
    ]) {
      const facts = await measure(true, 'rgba(255,255,255,0.2)', options);
      expect(railVerdict(facts.rows, facts.viewMode).pass, JSON.stringify(options)).toBe(false);
    }
  });
});
