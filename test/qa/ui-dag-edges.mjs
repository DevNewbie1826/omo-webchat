/** C003 built-SPA contract. Real Chrome, current wire snapshots, no DOM/CSS substitutes.
 * bun test/qa/ui-dag-edges.mjs --phase green --out DIR
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DRIVER, identity, session, select, settled, subjectBounds } from './ui-followup-activity.mjs';
import { arm, complete } from './design-workbench-fixture.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const states = ['pending', 'scheduled', 'blocked', 'running', 'completed', 'failed', 'cancelled', 'skipped', 'future-state'];
const sourceIdentity = async () => ({ ...await identity(), edgesRunner: sha(readFileSync(import.meta.filename)) });
export function edgeRun({ source = 'failed', destination = 'running', status = 'running', runId = 'run(/# edges)', reverse = false } = {}) {
  const nodes = [
    ['a', 'Fulfilled source', [], 'completed'], ['b', 'Other input', [], source],
    ['c', 'Execution target', ['a', 'b'], destination],
    // Keep the long static a -> d fan-out off the short a -> c flow lane.
    // Otherwise collinear green edges hide the rendered dash gaps in PNGs.
    ['e', 'Next preparation', ['c'], 'pending'], ['d', 'Next dependency', ['a', 'c'], 'pending'],
  ].map(([id, label, depends_on, state]) => ({ id, label, prompt: label, depends_on, state }));
  return { run_id: runId, run_key: 'edges', name: runId, status, nodes,
    updated_at: new Date(Date.now() - 10000).toISOString(),
    counts: Object.fromEntries(['total', ...states.slice(0, -1)].map(s => [s, s === 'total' ? nodes.length : nodes.filter(n => n.state === s).length])),
    edges: [{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }, { from: 'a', to: 'd' }, { from: 'c', to: 'd' }, { from: 'c', to: 'e' }, { from: 'absent', to: 'c' }, { from: 'a', to: 'absent' }],
    waves: reverse ? [{ index: 0, node_ids: ['c', 'd'] }, { index: 1, node_ids: ['a', 'b'] }, { index: 2, node_ids: ['e'] }] : [] };
}
function history(runs) {
  return { dag: { parent_session_id: 'qa', truncated_runs: false, runs }, task: { parent_session_id: 'qa', truncated_tasks: false,
    tasks: [{ task_id: 'direct', name: 'Direct activity probe', status: 'running', created_at: new Date(Date.now() - 5000).toISOString() }] } };
}

/** Independent oracle: compare actual computed colors/animation and endpoint geometry. */
export function assertEdges(data, runs, active = true) {
  assert.equal(data.graphs.length, runs.length);
  assert.equal(new Set(data.markerIds).size, data.markerIds.length, 'document-wide unique marker IDs');
  assert(data.markerIds.every(id => /^th-dag-arrow-[A-Za-z0-9_-]+$/.test(id)), 'safe IDs, never raw run IDs');
  for (const run of runs) {
    const graph = data.graphs.find(g => g.name === run.name);
    assert(graph, `missing run ${run.name}`);
    const nodes = new Map(run.nodes.map(n => [n.id, n]));
    const expected = run.edges.filter(e => nodes.has(e.from) && nodes.has(e.to));
    assert.equal(graph.edges.length, expected.length, 'missing endpoints must be omitted');
    expected.forEach((edge, i) => {
      const actual = graph.edges[i], fulfilled = nodes.get(edge.from).state === 'completed';
      const flowing = fulfilled && nodes.get(edge.to).state === 'running' && run.status === 'running' && active && !data.reduced;
      const token = data.tokens[fulfilled ? '--th-success' : '--th-border-strong'];
      assert.deepEqual(actual.strokeRGBA, token, `${edge.from}->${edge.to} line color`);
      assert.deepEqual(actual.headRGBA, token, `${edge.from}->${edge.to} marker color`);
      assert(actual.markerLocal, 'marker resolves in its own SVG');
      const markerId = actual.marker.slice(5, -1);
      assert(data.markerIds.includes(markerId), 'referenced marker exists');
      assert.equal(actual.markerComputed, `url("#${markerId}")`, 'computed marker reference remains usable');
      assert.equal(actual.orient, 'auto');
      assert.deepEqual(actual.markerViewport, [7, 6], 'stroke emphasis must not scale the arrowhead');
      assert.equal(actual.animation, flowing ? 'th-dag-edge-flow' : 'none');
      assert.equal(actual.live, flowing, 'actual CSSAnimation, not just class/attribute');
      assert.equal(actual.dash, flowing ? '8px, 4px' : 'none');
      if (flowing) { assert.equal(actual.duration, '1.2s'); assert.equal(actual.iterations, 'Infinity'); }
      const from = graph.nodes.find(n => n.id === edge.from), to = graph.nodes.find(n => n.id === edge.to);
      assert.deepEqual(actual.geometry, [from.x + from.width, from.y + from.height / 2, to.x, to.y + to.height / 2]);
    });
  }
}
async function inspect(page) {
  return page.evaluate(() => {
    const ctx = new OffscreenCanvas(1, 1).getContext('2d');
    const rgba = value => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
    const root = getComputedStyle(document.documentElement);
    return { reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      tokens: Object.fromEntries(['--th-success', '--th-border-strong'].map(t => [t, rgba(root.getPropertyValue(t).trim())])),
      markerIds: [...document.querySelectorAll('marker')].map(m => m.id),
      graphs: [...document.querySelectorAll('.th-activity-graph > svg')].map(svg => ({ name: svg.getAttribute('aria-label'),
        nodes: [...svg.querySelectorAll('[data-node]')].map(n => { const m = n.transform.baseVal.consolidate().matrix, r = n.querySelector('rect'); return { id: n.dataset.node, x: m.e, y: m.f, width: +r.getAttribute('width'), height: +r.getAttribute('height'), class: n.getAttribute('class') }; }),
        edges: [...svg.querySelectorAll('line.th-activity-gedge')].map(e => {
          const s = getComputedStyle(e), ref = e.getAttribute('marker-end'), marker = document.getElementById(ref.slice(5, -1));
          const head = marker?.querySelector('path'), a = e.getAnimations().find(a => a.animationName === 'th-dag-edge-flow');
          return { stroke: s.stroke, strokeRGBA: rgba(s.stroke), head: head ? getComputedStyle(head).fill : null, headRGBA: head ? rgba(getComputedStyle(head).fill) : null,
            marker: ref, markerComputed: s.markerEnd, markerLocal: marker?.closest('svg') === svg, orient: marker?.getAttribute('orient'),
            strokeWidth: s.strokeWidth, markerUnits: marker?.getAttribute('markerUnits') ?? 'strokeWidth',
            markerViewport: marker ? ['markerWidth', 'markerHeight'].map(k => +marker.getAttribute(k) * (marker.getAttribute('markerUnits') === 'userSpaceOnUse' ? 1 : parseFloat(s.strokeWidth))) : null,
            animation: s.animationName, live: !!a && a.playState === 'running', duration: s.animationDuration, iterations: a?.effect.getTiming().iterations === Infinity ? 'Infinity' : null,
            dash: s.strokeDasharray, offset: s.strokeDashoffset, geometry: ['x1', 'y1', 'x2', 'y2'].map(k => +e.getAttribute(k)), rect: e.getBoundingClientRect().toJSON() };
        }) })) };
  });
}
async function capture(q, name, runs, active = true, visible = true) {
  const data = await inspect(q.page);
  assertEdges(data, runs, active);
  const geometry = [];
  if (visible) for (const node of runs.flatMap(run => run.nodes)) geometry.push(await subjectBounds(q, { id: node.id }));
  const path = join(q.out, `${name}.png`);
  await q.page.screenshot({ path, animations: 'allow' });
  q.manifest.push({ name: `${name}.png`, sha256: sha(readFileSync(path)), fixture: q.record.id, sourceIdentity: q.identityHash });
  const result = { name, data, geometry };
  q.record.actions.push({ action: 'capture', ...result });
  return result;
}
async function deliver(q, run, closed = false) {
  q.revision = Math.max(Date.now(), (q.revision ?? 0) + 1);
  run = { ...run, name: `${run.run_id} revision ${q.revision}`, updated_at: new Date(q.revision).toISOString() };
  await arm(q.page, closed
    ? new Function(`return document.querySelector('[data-activity-tab="dag"] .th-activity-tab-count')?.textContent === ${JSON.stringify(`${run.counts.completed}/${run.counts.total}`)}`)
    : new Function(`return [...document.querySelectorAll('.th-activity-dag-name')].some(e => e.textContent === ${JSON.stringify(run.name)})`));
  q.record.actions.push({ action: 'dag-frame', run: structuredClone(run) });
  q.fixture.deliver('stored-a', { type: 'extensionEvent', name: 'omo.dag.updated', data: { parent_session_id: 'qa', truncated_runs: false, runs: [run] } });
  await complete(q.page); await settled(q.page);
  return run;
}
async function click(q, selector, predicate) {
  await arm(q.page, predicate);
  q.record.actions.push({ action: 'click', selector });
  await q.page.locator(selector).click(); await complete(q.page); await settled(q.page);
}
async function direction(q, name) {
  const natural = await q.page.evaluate(() => new Promise((done, fail) => {
    let frame;
    const timer = setTimeout(() => { cancelAnimationFrame(frame); fail(new Error('Edge frame deadline')); }, 8000);
    const sample = () => [...document.querySelectorAll('.th-activity-gedge--flow')].map(e => {
      const a = e.getAnimations().find(a => a.animationName === 'th-dag-edge-flow');
      return { time: a?.currentTime, offset: parseFloat(getComputedStyle(e).strokeDashoffset), geometry: ['x1', 'y1', 'x2', 'y2'].map(k => +e.getAttribute(k)) };
    });
    frame = requestAnimationFrame(() => { const before = sample(); frame = requestAnimationFrame(() => { clearTimeout(timer); done({ before, after: sample() }); }); });
  }));
  assert(natural.before.length > 0);
  natural.before.forEach((a, i) => { const b = natural.after[i]; assert(b.time > a.time); assert.notEqual(b.offset, a.offset); });
  const timeline = [];
  try {
    for (const time of [0, 300, 600]) {
      const samples = await q.page.evaluate(time => [...document.querySelectorAll('.th-activity-gedge--flow')].map(e => {
        const a = e.getAnimations().find(a => a.animationName === 'th-dag-edge-flow'); a.pause(); a.currentTime = time;
        const geometry = ['x1', 'y1', 'x2', 'y2'].map(k => +e.getAttribute(k));
        const [x1, y1, x2, y2] = geometry, length = Math.hypot(x2 - x1, y2 - y1), offset = parseFloat(getComputedStyle(e).strokeDashoffset);
        return { time: a.currentTime, offset, geometry, keyframes: a.effect.getKeyframes(),
          dashTravel: { distance: -offset, x: x1 - offset * (x2 - x1) / length, y: y1 - offset * (y2 - y1) / length } };
      }), time);
      samples.forEach(s => assert(Math.abs(s.offset + time / 100) < .001, 'negative offset advances along source-to-destination vector'));
      const file = `${name}-direction-${time}.png`, path = join(q.out, file);
      await q.page.screenshot({ path, animations: 'allow' });
      q.manifest.push({ name: file, sha256: sha(readFileSync(path)), fixture: q.record.id, sourceIdentity: q.identityHash });
      timeline.push({ time, samples, png: file });
    }
  } finally {
    await q.page.evaluate(async () => {
      const animations = [...document.querySelectorAll('.th-activity-gedge--flow')].flatMap(e => e.getAnimations());
      let timer;
      try {
        for (const animation of animations) animation.play();
        await Promise.race([Promise.all(animations.map(a => a.ready)), new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('Edge playback ready deadline')), 8000); })]);
      } finally { clearTimeout(timer); }
    });
  }
  return { natural, timeline };
}
async function elapsed(q) {
  // Subscribe to the actual elapsed label mutation, without clocks or DAG traffic.
  return q.page.evaluate(() => new Promise((done, fail) => {
    const row = [...document.querySelectorAll('.th-activity-agent')].find(e => e.querySelector('.th-activity-agent-name')?.textContent === 'Direct activity probe');
    const label = row?.querySelector('.th-activity-agent-meta:not(.th-activity-agent-turns):not(.th-activity-agent-toolcalls):not(.th-activity-agent-rate):not(.th-activity-quiet-note)');
    if (!label) { fail(new Error('Elapsed label missing')); return; }
    const beforeLabel = label.textContent;
    const edges = [...document.querySelectorAll('.th-activity-gedge')], attrs = edges.map(e => e.outerHTML);
    const animations = edges.flatMap(e => e.getAnimations()), starts = animations.map(a => a.startTime);
    const times = animations.map(a => a.currentTime);
    let frame;
    const timer = setTimeout(() => { cleanup(); fail(new Error('Elapsed mutation deadline')); }, 8000);
    function cleanup() { clearTimeout(timer); cancelAnimationFrame(frame); observer.disconnect(); }
    const observer = new MutationObserver(() => {
      if (label.textContent === beforeLabel) return;
      observer.disconnect();
      frame = requestAnimationFrame(() => {
        const current = [...document.querySelectorAll('.th-activity-gedge')], currentAnimations = current.flatMap(e => e.getAnimations());
        const result = { beforeLabel, afterLabel: label.textContent, edgeCount: edges.length, animationCount: animations.length,
          sameDOM: edges.length === current.length && edges.every((e, i) => e === current[i]), sameAttributes: edges.every((e, i) => e.outerHTML === attrs[i]),
          sameAnimations: animations.length === currentAnimations.length && animations.every((a, i) => a === currentAnimations[i]), sameStarts: animations.every((a, i) => a.startTime === starts[i]),
          advanced: animations.every((a, i) => a.currentTime > times[i]), starts, times, afterTimes: animations.map(a => a.currentTime) };
        cleanup(); done(result);
      });
    });
    observer.observe(label, { childList: true, characterData: true, subtree: true });
  }));
}
async function single(q, theme) {
  let run = q.record.seed.history.dag.runs[0];
  await select(q, 'dag'); await settled(q.page);
  await capture(q, `${theme}-initial`, [run]);
  const forward = await direction(q, `${theme}-forward`);
  const traffic = q.fixture.traffic.length;
  const tick = await elapsed(q);
  q.record.actions.push({ action: 'elapsed-identity', tick });
  assert.equal(q.fixture.traffic.length, traffic, 'no wire action during elapsed proof');
  for (const key of ['sameDOM', 'sameAttributes', 'sameAnimations', 'sameStarts', 'advanced']) assert(tick[key], key);
  assert(tick.animationCount > 0); assert.notEqual(tick.beforeLabel, tick.afterLabel);
  for (const destination of states) {
    run = await deliver(q, edgeRun({ destination }));
    await capture(q, `${theme}-destination-${destination}`, [run]);
  }
  for (const source of states) {
    run = await deliver(q, edgeRun({ source }));
    await capture(q, `${theme}-source-${source}`, [run]);
  }
  for (const status of ['completed', 'failed', 'cancelled', 'skipped', 'pending', 'scheduled', 'blocked', 'future-run', 'running']) {
    run = await deliver(q, edgeRun({ status }));
    await capture(q, `${theme}-run-${status}`, [run]);
  }
  // Retry changes the source itself; no completion latch survives it.
  run = await deliver(q, { ...edgeRun(), nodes: edgeRun().nodes.map(n => n.id === 'a' ? { ...n, state: 'pending' } : n) });
  await capture(q, `${theme}-retry-pending`, [run]);
  run = await deliver(q, edgeRun());
  await capture(q, `${theme}-retry-completed`, [run]);
  const exits = [];
  for (const exit of ['tab', 'close', 'list', 'reduced']) {
    if (exit === 'tab') await select(q, 'todo');
    if (exit === 'close') await click(q, '[data-activity-tab="dag"]', () => !document.querySelector('.th-activity-panel'));
    if (exit === 'list') await click(q, '[data-view="list"]', () => !document.querySelector('.th-activity-graph'));
    if (exit === 'reduced') await q.page.emulateMedia({ reducedMotion: 'reduce' });
    const hidden = await capture(q, `${theme}-${exit}-stopped`, exit === 'tab' || exit === 'reduced' ? [run] : [], exit !== 'tab', exit === 'reduced');
    const live = await q.page.evaluate(() => document.getAnimations().filter(a => a.animationName === 'th-dag-edge-flow').length);
    assert.equal(live, 0, `${exit} stops flow`);
    await q.page.evaluate(() => {
      window.edgeReturnStarts = [];
      window.edgeReturnListener = e => { if (/^th-dag-node-(enter|settle)$/.test(e.animationName)) window.edgeReturnStarts.push(e.animationName); };
      document.addEventListener('animationstart', window.edgeReturnListener, true);
    });
    try {
      if (exit === 'tab' || exit === 'close') await select(q, 'dag');
      if (exit === 'list') await click(q, '[data-view="graph"]', () => !!document.querySelector('.th-activity-graph'));
      if (exit === 'reduced') await q.page.emulateMedia({ reducedMotion: 'no-preference' });
      await settled(q.page);
      const returned = await capture(q, `${theme}-${exit}-returned`, [run]);
      const starts = await q.page.evaluate(() => window.edgeReturnStarts);
      assert.deepEqual(starts, []);
      assert(returned.data.graphs.every(g => g.nodes.every(n => !/--enter|--settle/.test(n.class))));
      exits.push({ exit, hidden, live, starts, returned });
    } finally { await q.page.evaluate(() => document.removeEventListener('animationstart', window.edgeReturnListener, true)); }
  }
  run = await deliver(q, edgeRun({ reverse: true, source: 'completed' }));
  await capture(q, `${theme}-backward-geometry`, [run]);
  const backward = await direction(q, `${theme}-backward`);
  assert(backward.natural.before.some(s => s.geometry[2] < s.geometry[0]), 'exercise reversed source/destination coordinates');
  return { forward, tick, exits, backward };
}

async function observeVisibilityReturn(page, expectedNew) {
  await page.evaluate(expectedNew => {
    window.visibilityStarts = [];
    let flow = false, entered = false;
    window.visibilitySignal = new Promise((done, fail) => {
      window.visibilityTimer = setTimeout(() => fail(new Error('Visibility animationstart deadline')), 8000);
      window.visibilityListener = event => {
        const item = { name: event.animationName, id: event.target.getAttribute('data-node') };
        window.visibilityStarts.push(item);
        flow ||= item.name === 'th-dag-edge-flow';
        entered ||= item.name === 'th-dag-node-enter' && item.id === 'new';
        if (flow && (!expectedNew || entered)) { clearTimeout(window.visibilityTimer); done(true); }
      };
      document.addEventListener('animationstart', window.visibilityListener, true);
    });
  }, expectedNew);
}
async function visibilityReturn(q, label, run, expectedNew, action) {
  await observeVisibilityReturn(q.page, expectedNew);
  try {
    const latest = await action(); await q.page.evaluate(() => window.visibilitySignal); await settled(q.page);
    const after = await capture(q, label, [latest ?? run]);
    const starts = await q.page.evaluate(() => window.visibilityStarts);
    const oneShots = starts.filter(e => /^th-dag-node-(enter|settle)$/.test(e.name));
    q.record.actions.push({ action: 'visibility-return-events', label, starts });
    assert.deepEqual(oneShots, expectedNew ? [{ name: 'th-dag-node-enter', id: 'new' }] : [], 'seen node one-shots never replay; new node enters exactly once');
    if (expectedNew) await subjectBounds(q, { id: 'new' });
    return { after, starts };
  } finally {
    await q.page.evaluate(() => { clearTimeout(window.visibilityTimer); document.removeEventListener('animationstart', window.visibilityListener, true); });
  }
}
function withNewNode(run) {
  return { ...run, nodes: [...run.nodes, { id: 'new', label: 'First visible entry', prompt: 'First visible entry', depends_on: ['a'], state: 'running' }],
    edges: [...run.edges, { from: 'a', to: 'new' }], counts: { ...run.counts, total: run.counts.total + 1, running: run.counts.running + 1 } };
}
async function adversarialVisibility(q, theme, mode) {
  let run = q.record.seed.history.dag.runs[0];
  await select(q, 'dag'); await settled(q.page);
  await capture(q, `${theme}-${mode}-before`, [run]);
  if (mode === 'tab') await select(q, 'todo');
  if (mode === 'close') await click(q, '[data-activity-tab="dag"]', () => !document.querySelector('.th-activity-panel'));
  if (mode === 'list') await click(q, '[data-view="list"]', () => !document.querySelector('.th-activity-graph'));
  run = { ...run, nodes: run.nodes.map(n => n.id === 'b' ? { ...n, state: 'failed' } : n), counts: { ...run.counts, completed: run.counts.completed - 1, failed: run.counts.failed + 1 } };
  if (mode !== 'initial-reduced') run = withNewNode(run);
  run = await deliver(q, run, mode === 'close');
  await capture(q, `${theme}-${mode}-snapshot`, mode === 'close' || mode === 'list' ? [] : [run], mode === 'initial-reduced', mode === 'initial-reduced');
  const returned = await visibilityReturn(q, `${theme}-${mode}-fresh-return`, run, mode !== 'initial-reduced', async () => {
    if (mode === 'tab' || mode === 'close') await select(q, 'dag');
    if (mode === 'list') await click(q, '[data-view="graph"]', () => !!document.querySelector('.th-activity-graph'));
    if (mode === 'initial-reduced') await q.page.emulateMedia({ reducedMotion: 'no-preference' });
  });
  let newVisible = null;
  if (mode === 'initial-reduced') {
    run = withNewNode(run);
    // Subscribe before the live snapshot; don't infer first entry from a leftover class.
    newVisible = await visibilityReturn(q, `${theme}-${mode}-new-live-entry`, run, true, async () => { run = await deliver(q, run); return run; });
  }
  return { mode, returned, newVisible };
}

export function assertCollinearProfiles(profiles) {
  assert.deepEqual(profiles.map(p => p.time), [0, 300, 600]);
  for (const profile of profiles) {
    const expected = profile.distances.map(distance => ((distance + .5 - profile.time / 100) % 12 + 12) % 12 < 8);
    for (const row of profile.rows) {
      const actual = row.pixels.map(pixel => pixel.every((value, i) => value === profile.green[i]));
      // The static fulfilled edge keeps the center solid; motion must paint a
      // distinct footprint outside it, in both rails, not just change CSS time.
      assert.deepEqual(actual, row.dy === 0 ? expected.map(() => true) : expected, `visible directional footprint at ${profile.time}ms, row ${row.dy}`);
    }
    assert.deepEqual(profile.rows.map(row => row.dy), [-1, 0, 1]);
    assert(profile.distances.length >= 12, 'sample a full dash period');
  }
}
async function collinearPixels(q, file, edge, time) {
  const encoded = readFileSync(join(q.out, file)).toString('base64');
  return q.page.evaluate(async ({ encoded, edge, time }) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], { type: 'image/png' }));
    try {
      const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d'); ctx.drawImage(bitmap, 0, 0);
      const distances = Array.from({ length: 14 }, (_, i) => i + 2);
      return { time, distances, green: edge.strokeRGBA.slice(0, 3), rect: edge.rect,
        rows: [-1, 0, 1].map(dy => ({ dy, pixels: distances.map(distance => [...ctx.getImageData(Math.floor(edge.rect.x + distance), Math.floor(edge.rect.y) + dy, 1, 1).data].slice(0, 3)) })) };
    } finally { bitmap.close(); }
  }, { encoded, edge, time });
}
async function collinear(q, theme) {
  let run = q.record.seed.history.dag.runs[0];
  await select(q, 'dag'); await settled(q.page);
  const before = await capture(q, `${theme}-collinear-before`, [run]);
  const [flow, , fanOut] = before.data.graphs[0].edges;
  assert.equal(flow.geometry[1], flow.geometry[3]);
  assert.deepEqual(fanOut.geometry.slice(0, 2), flow.geometry.slice(0, 2));
  assert.equal(fanOut.geometry[3], flow.geometry[3]);
  assert(fanOut.geometry[2] > flow.geometry[2], 'original long static fan-out covers the entire short flow lane');
  assert.equal(fanOut.animation, 'none');
  const line = await q.page.locator('line.th-activity-gedge').first().elementHandle();
  try {
    const motion = await direction(q, `${theme}-collinear`);
    const profiles = [];
    for (const frame of motion.timeline) profiles.push(await collinearPixels(q, frame.png, flow, frame.time));
    run = await deliver(q, { ...run, status: 'failed' });
    const stopped = await capture(q, `${theme}-collinear-stopped`, [run]);
    const stoppedPixels = await collinearPixels(q, `${theme}-collinear-stopped.png`, stopped.data.graphs[0].edges[0], 0);
    assert(await line.evaluate(e => e === document.querySelector('line.th-activity-gedge')));
    assert.deepEqual(stopped.data.graphs[0].edges.map(e => [e.geometry, e.marker, e.markerViewport]), before.data.graphs[0].edges.map(e => [e.geometry, e.marker, e.markerViewport]));
    q.record.result = { before, motion, profiles, stopped, stoppedPixels };
    for (const row of stoppedPixels.rows.filter(row => row.dy !== 0)) {
      assert(row.pixels.every(pixel => !pixel.every((value, i) => value === stoppedPixels.green[i])), 'terminal run removes the wider footprint');
    }
    assertCollinearProfiles(profiles);
    return q.record.result;
  } finally { await line.dispose(); }
}

export async function run({ phase = 'green', out, qaPlaywright = DRIVER } = {}) {
  assert.equal(phase, 'green'); assert(out); out = resolve(out); mkdirSync(out, { recursive: true });
  const receipt = { phase, out, command: `bun test/qa/ui-dag-edges.mjs --phase ${phase} --out ${out}`, startedAt: new Date().toISOString(), identity: await sourceIdentity(), fixtures: [], scenarios: [], manifest: [] };
  receipt.identityHash = sha(JSON.stringify(receipt.identity));
  let browser, profile, browserPid;
  try {
    const { chromium } = await import(qaPlaywright);
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-automation'] });
    const cdp = await browser.newBrowserCDPSession();
    try {
      const { arguments: args } = await cdp.send('Browser.getBrowserCommandLine');
      profile = args.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
      browserPid = (await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(p => p.type === 'browser')?.id;
      receipt.browser = { version: browser.version(), profile, pid: browserPid }; assert(profile && browserPid);
    } finally { await cdp.detach(); }
    for (const theme of ['dark', 'light']) {
      const scenario = { name: `${theme}-state-motion-matrix` }; receipt.scenarios.push(scenario);
      await session(browser, receipt, { theme, history: history([edgeRun({ source: 'completed' })]), elapsedOnly: true }, q => single(q, theme));
      scenario.ok = true; console.log(`PASS ${scenario.name}`);
    }
    const scenario = { name: 'multiple-shelves-runs-safe-markers' }; receipt.scenarios.push(scenario);
    const runs = [edgeRun({ runId: 'unsafe(/# one)' }), edgeRun({ runId: 'unsafe(/# two)', source: 'completed' })];
    const layout = { kind: 'split', id: 'root', dir: 'h', ratio: .5, first: { kind: 'leaf', id: 'a', sessionId: 'stored-a' }, second: { kind: 'leaf', id: 'b', sessionId: 'newer' } };
    await session(browser, receipt, { layout, noTodo: true, viewport: { width: 1800, height: 1100 }, history: history(runs) }, async q => {
      await q.page.evaluate(() => window.qaSignal(() => document.querySelectorAll('.th-activity-shelf').length === 2));
      for (let i = 0; i < 2; i++) {
        await arm(q.page, new Function(`return document.querySelectorAll('.th-activity-shelf')[${i}]?.dataset.expanded === 'true'`));
        await q.page.locator('.th-activity-shelf').nth(i).locator('[data-activity-tab="dag"]').click(); await complete(q.page);
      }
      await settled(q.page);
      const data = await inspect(q.page);
      assert.equal(data.graphs.length, 4); assert.equal(data.markerIds.length, 8);
      assert.equal(new Set(data.markerIds).size, 8);
      // Each shelf resolves all of its own variants, despite identical raw IDs.
      for (const start of [0, 2]) assertEdges({ ...data, graphs: data.graphs.slice(start, start + 2) }, runs);
      const path = join(q.out, 'multiple-shelves-runs.png'); await q.page.screenshot({ path, animations: 'allow' });
      q.manifest.push({ name: 'multiple-shelves-runs.png', sha256: sha(readFileSync(path)), fixture: q.record.id, sourceIdentity: q.identityHash });
      const survivor = await q.page.locator('.th-activity-shelf').nth(1).locator('line').first().elementHandle();
      const ref = await survivor.getAttribute('marker-end');
      await arm(q.page, () => document.querySelectorAll('.th-activity-graph').length === 2);
      await q.page.locator('.th-activity-shelf').first().locator('[data-activity-tab="dag"]').click(); await complete(q.page);
      const surviving = await inspect(q.page); assertEdges(surviving, runs);
      assert.equal(await survivor.getAttribute('marker-end'), ref); assert(await survivor.evaluate(e => e.isConnected)); await survivor.dispose();
      return { data, surviving };
    });
    scenario.ok = true; console.log(`PASS ${scenario.name}`);
    for (const theme of ['dark', 'light']) for (const mode of ['initial-reduced', 'tab', 'close', 'list']) {
      const scenario = { name: `${theme}-adversarial-${mode}` }; receipt.scenarios.push(scenario);
      try {
        await session(browser, receipt, { theme, reduced: mode === 'initial-reduced', history: history([edgeRun({ source: 'completed' })]) }, q => adversarialVisibility(q, theme, mode));
        scenario.ok = true;
      } catch (error) { scenario.ok = false; scenario.error = String(error.stack ?? error); }
      console.log(`${scenario.ok ? 'PASS' : 'FAIL'} ${scenario.name}${scenario.error ? ': ' + scenario.error.split('\n')[0] : ''}`);
    }
    for (const theme of ['dark', 'light']) {
      const scenario = { name: `${theme}-legal-collinear-flow` }; receipt.scenarios.push(scenario);
      const base = edgeRun();
      const original = { ...base, nodes: base.nodes.filter(n => n.id !== 'e'), edges: base.edges.filter(e => e.to !== 'e'), counts: { ...base.counts, total: 4, pending: 1 } };
      try {
        await session(browser, receipt, { theme, history: history([original]) }, q => collinear(q, theme));
        scenario.ok = true;
      } catch (error) { scenario.ok = false; scenario.error = String(error.stack ?? error); }
      console.log(`${scenario.ok ? 'PASS' : 'FAIL'} ${scenario.name}${scenario.error ? ': ' + scenario.error.split('\n')[0] : ''}`);
    }
  } catch (error) { receipt.failure = String(error.stack ?? error); }
  finally {
    if (browser) {
      const disconnected = once(browser, 'disconnected'); await browser.close(); await disconnected;
      let processGone = false;
      if (browserPid) { try { process.kill(browserPid, 0); } catch (error) { if (error.code !== 'ESRCH') throw error; processGone = true; } }
      receipt.cleanup = { browserClosed: !browser.isConnected(), contexts: browser.contexts().length, processGone, profileRemoved: !!profile && !existsSync(profile) };
    }
    receipt.identityAfter = await sourceIdentity(); receipt.sourceStable = JSON.stringify(receipt.identity) === JSON.stringify(receipt.identityAfter);
    receipt.pendingWorkZero = receipt.fixtures.length === 13 && receipt.fixtures.every(f => f.cleanup.contextClosed && f.cleanup.fixture?.serverStopped && f.cleanup.portClosed === 'ECONNREFUSED' && ['pendingWebSockets', 'pendingOpens', 'pendingCreates'].every(k => f.cleanup.fixture[k] === 0) && f.cleanup.errors.length === 0);
    receipt.verdict = !receipt.failure && receipt.scenarios.length === 13 && receipt.scenarios.every(s => s.ok) && receipt.sourceStable && receipt.pendingWorkZero && receipt.cleanup?.browserClosed && receipt.cleanup.contexts === 0 && receipt.cleanup.processGone && receipt.cleanup.profileRemoved ? 'PASS' : 'FAIL';
    receipt.finishedAt = new Date().toISOString();
    writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2)); writeFileSync(join(out, 'manifest.json'), JSON.stringify(receipt.manifest, null, 2));
  }
  assert.equal(receipt.verdict, 'PASS', `edges ${phase} failed; see ${join(out, 'receipt.json')}${receipt.failure ? '\n' + receipt.failure : ''}`);
  return { verdict: receipt.verdict, scenarios: receipt.scenarios.length, pngs: receipt.manifest.length, out };
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  try { console.log(await run({ phase: args[args.indexOf('--phase') + 1], out: args[args.indexOf('--out') + 1], qaPlaywright: process.env.QA_PLAYWRIGHT ?? DRIVER })); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
