/** Activity real-SPA acceptance. Baseline is a new run, never historical evidence.
 * bun test/qa/ui-followup-activity.mjs --phase baseline|regression|green --out DIR
 * Inventory: baseline old controls; tabs/counts/empty/keyboard/history/freshness;
 * per-view scroll, List/fold, resize/reload; both-open desktop/mobile/340/short;
 * dark/light x en/ko x font13/24 graph/agents/tabs; directional/horizontal graph;
 * actual entry/completed/failed/running frames, six independently seeded
 * interrupted tab/fold/List cases with viewport/ancestor-clip proof,
 * elapsed-only identity/no-replay, hidden and reduced motion. No readiness polling.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { connect } from 'node:net';
import { startFixture } from './pane-workspace-ui.mjs';
import { arm, complete, wheel } from './design-workbench-fixture.mjs';
import { exerciseShelves } from './design-workbench-controls.mjs';
import { shelfRegressionScenarios } from './pane-workspace-composer.mjs';

const ROOT = resolve(import.meta.dir, '../..');
const DRIVER = '/Users/mirage/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = promisify(execFile);
async function identity() {
  const commands = [['head', ['rev-parse', 'HEAD']], ['tree', ['rev-parse', 'HEAD^{tree}']], ['status', ['status', '--porcelain']], ['files', ['ls-files']]];
  const facts = Object.fromEntries(await Promise.all(commands.map(async ([name, args]) => [name, (await git('git', args, { cwd: ROOT })).stdout.trim()])));
  facts.source = Object.fromEntries(facts.files.split('\n').map(path => [path, sha(readFileSync(join(ROOT, path)))]));
  delete facts.files;
  facts.runner = sha(readFileSync(import.meta.filename));
  facts.dist = {};
  function visit(path) { for (const entry of readdirSync(join(ROOT, path), { withFileTypes: true })) {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) visit(child); else facts.dist[child] = sha(readFileSync(join(ROOT, child)));
  } }
  visit('frontend/dist');
  return facts;
}
function seed() {
  const now = Date.now(), iso = ms => new Date(now - ms).toISOString();
  const nodes = [
    ['a', 'Inspect shared shelf allocator', [], 'completed'],
    ['b', 'Verify stable graph identity', [], 'completed'],
    ['c', 'Graph default and purposeful motion', ['a'], 'running'],
    ['k', '매우 긴 한글 노드 라벨은 두 줄로 표시되어야 합니다', ['a', 'b'], 'failed'],
    ['e', 'Reserve transcript', ['c'], 'running'],
    ['f', 'Final capture', ['e', 'k'], 'pending'],
  ].map(([id, label, depends_on, state]) => ({ id, label, prompt: label, depends_on, state }));
  const run = { run_id: 'qa-r2', run_key: 'activity', name: 'Activity verification', status: 'running', created_at: iso(400000), updated_at: iso(5000), nodes,
    edges: nodes.flatMap(n => n.depends_on.map(from => ({ from, to: n.id }))), waves: [],
    counts: { total: 6, pending: 1, blocked: 0, scheduled: 0, running: 2, completed: 2, failed: 1, cancelled: 0, skipped: 0 } };
  const tasks = [{ task_id: 'direct', name: 'Direct activity probe', status: 'running', created_at: iso(300000), updated_at: iso(4000), live_progress: { current_tool: 'read', turns: 3, last_assistant_line: 'Inspect geometry' } },
    { task_id: 'done', name: 'Retained completed task', status: 'completed', created_at: iso(600000), updated_at: iso(60000) }];
  const todo = [{ name: 'Verification', tasks: Array.from({ length: 32 }, (_, i) => ({ content: `Activity verification row ${i}`, status: i === 0 ? 'completed' : i === 1 ? 'in_progress' : 'pending' })) }];
  return { run, tasks, todo, history: { task: { parent_session_id: 'qa', truncated_tasks: false, tasks }, dag: { parent_session_id: 'qa', truncated_runs: false, runs: [run] } } };
}
const tab = id => `[data-activity-tab="${id}"]`;
const panel = id => `[data-activity-tabpanel="${id}"]`;
const fold = 'button.th-activity-fold';
const view = id => `.th-activity-view-btn[data-view="${id}"]`;
const interruptionCases = ['tab', 'fold', 'list'].flatMap(switchName => [false, true].map(terminal => ({ switchName, terminal })));
async function state(page) {
  return page.evaluate(() => {
    const box = s => document.querySelector(s)?.getBoundingClientRect().toJSON() ?? null;
    const tabs = [...document.querySelectorAll('[data-activity-tab]')].map(e => ({ id: e.dataset.activityTab, selected: e.getAttribute('aria-selected'), rect: e.getBoundingClientRect().toJSON(), count: e.querySelector('.th-activity-tab-count')?.textContent, display: getComputedStyle(e).display }));
    const column = document.querySelector('.th-chat-main'), content = column.querySelector(':scope > .th-chat-main-content');
    const margin = e => { const s = getComputedStyle(e); return (parseFloat(s.marginTop) || 0) + (parseFloat(s.marginBottom) || 0); };
    const outer = e => e.getBoundingClientRect().height + margin(e);
    let fixed = 0;
    for (const child of [...column.children, ...(content?.children ?? [])]) {
      if (child === content || child.matches('.th-chat-scrollport,.th-goal-shelf,.th-activity-shelf,.th-goal-panel,.th-activity-panel') || child.querySelector('.th-goal-shelf,.th-activity-shelf')) continue;
      fixed += outer(child);
    }
    for (const shelf of column.querySelectorAll('.th-goal-shelf,.th-activity-shelf')) { fixed += margin(shelf); for (const band of shelf.querySelectorAll('.th-activity-bar-row,.th-activity-tabs,.th-activity-resize')) fixed += outer(band); }
    return { at: performance.now(), fixed, usable: column.getBoundingClientRect().height - fixed, tabs, visible: [...document.querySelectorAll('[data-activity-tabpanel]')].filter(e => !e.hidden && e.getClientRects().length).map(e => e.dataset.activityTabpanel),
      settings: { theme: document.documentElement.dataset.theme, lang: document.documentElement.lang, fontSize: localStorage.getItem('th-font-size'), font: getComputedStyle(document.documentElement).getPropertyValue('--th-font-mono') },
      pane: box('.th-chat-pane'), column: box('.th-chat-main'), transcript: box('.th-chat-scrollport'), goal: box('.th-goal-panel'), activity: box('.th-activity-panel'), composer: box('.th-chat-input'),
      goalOpen: document.querySelector('.th-goal-bar')?.getAttribute('aria-expanded'), activityOpen: document.querySelector('button.th-activity-fold')?.getAttribute('aria-expanded'),
      goalIntent: !!document.querySelector('.th-goal-shelf .th-activity-caret--open'), activityIntent: !!document.querySelector('.th-activity-shelf .th-activity-caret--open'),
      allocated: [...document.querySelectorAll('.th-goal-shelf,.th-activity-shelf')].map(e => e.style.flexShrink),
      panelMax: document.querySelector('.th-activity-panel')?.style.maxHeight, stored: localStorage.getItem('th-activity-panel-height'),
      scroll: [...document.querySelectorAll('[data-activity-tabpanel],.th-activity-graph')].map(e => ({ owner: e.dataset.activityTabpanel ?? 'graph', top: e.scrollTop, left: e.scrollLeft, height: e.clientHeight, width: e.clientWidth, scrollHeight: e.scrollHeight, scrollWidth: e.scrollWidth })),
      animations: document.getAnimations().filter(a => a.effect?.target?.closest?.('.th-activity-shelf')).map(a => ({ name: a.animationName, time: a.currentTime, playState: a.playState, node: a.effect.target.closest('[data-node]')?.dataset.node, transform: getComputedStyle(a.effect.target).transform })),
      nodes: [...document.querySelectorAll('.th-activity-gnode')].map(e => ({ id: e.dataset.node, transform: e.getAttribute('transform'), class: e.getAttribute('class'), opacity: getComputedStyle(e).opacity })),
      partial: document.querySelector('.th-activity-partial')?.textContent ?? null,
      freshness: [...document.querySelectorAll('.th-activity-quiet-note,.th-activity-severed-note')].map(e => e.textContent),
      overflow: document.documentElement.scrollWidth > innerWidth };
  });
}
async function settled(page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    const animations = document.getAnimations().filter(a => a.effect?.target?.closest?.('.th-activity-shelf') && a.effect.getTiming().iterations !== Infinity);
    let timer;
    try {
      const outcomes = await Promise.race([Promise.allSettled(animations.map(a => a.finished)), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Finite animation deadline')), 8000); })]);
      return outcomes.map((outcome, index) => {
        const animation = animations[index];
        if (outcome.status === 'rejected' && (outcome.reason.name !== 'AbortError' || animation.playState !== 'idle')) throw outcome.reason;
        return { name: animation.animationName ?? animation.transitionProperty, outcome: outcome.status === 'fulfilled' ? 'finished' : 'cancelled', playState: animation.playState, reason: outcome.status === 'rejected' ? String(outcome.reason) : null };
      });
    } finally { clearTimeout(timer); }
  });
}
async function click(q, selector, predicate) {
  assert.equal(await q.page.locator(selector).count(), 1, `missing or ambiguous control ${selector}`);
  await arm(q.page, predicate);
  q.record.actions.push({ action: 'click', selector, before: await state(q.page) });
  await q.page.locator(selector).click();
  await complete(q.page);
  q.record.actions.at(-1).after = await state(q.page);
}
async function select(q, id) {
  await click(q, tab(id), new Function(`return document.querySelector('${tab(id)}')?.getAttribute('aria-selected') === 'true' && !!document.querySelector('${panel(id)}') && !document.querySelector('${panel(id)}').hidden`));
}
async function open(q) { await select(q, 'todo'); }
async function changeView(q, id) {
  await click(q, view(id), new Function(`return document.querySelector('${view(id)}')?.getAttribute('aria-pressed') === 'true'`));
}
async function subjectBounds(q, subject) {
  const proof = await q.page.evaluate(({ id, future }) => {
    const node = document.querySelector(`[data-node="${id}"]`);
    if (future ? node !== null : node === null) throw new Error(`Unexpected subject presence: ${id}/${future}`);
    // The new child of c occupies layer2/row1: the real e column and k row.
    // Measure that EMPTY position without inserting a placeholder into the SPA.
    const anchor = future ? document.querySelector('[data-node="e"]') : node;
    const box = anchor.getBoundingClientRect();
    const row = future ? document.querySelector('[data-node="k"]').getBoundingClientRect() : box;
    const rect = { left: box.left, right: box.right, top: row.top, bottom: row.top + box.height, width: box.width, height: box.height };
    const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const intersection = { ...rect }, clips = [];
    function intersect(bounds, x, y) {
      if (x) { intersection.left = Math.max(intersection.left, bounds.left); intersection.right = Math.min(intersection.right, bounds.right); }
      if (y) { intersection.top = Math.max(intersection.top, bounds.top); intersection.bottom = Math.min(intersection.bottom, bounds.bottom); }
    }
    intersect(viewport, true, true);
    let visible = getComputedStyle(anchor).visibility === 'visible' && anchor.getClientRects().length > 0;
    for (let ancestor = anchor.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor), b = ancestor.getBoundingClientRect();
      visible &&= style.display !== 'none' && style.visibility === 'visible';
      const x = style.overflowX !== 'visible', y = style.overflowY !== 'visible';
      if (!x && !y) continue;
      const bounds = ancestor instanceof SVGElement ? { left: b.left, top: b.top, right: b.right, bottom: b.bottom }
        : { left: b.left + ancestor.clientLeft, top: b.top + ancestor.clientTop, right: b.left + ancestor.clientLeft + ancestor.clientWidth, bottom: b.top + ancestor.clientTop + ancestor.clientHeight };
      intersect(bounds, x, y);
      clips.push({ tag: ancestor.tagName, class: ancestor.getAttribute('class'), overflowX: style.overflowX, overflowY: style.overflowY, bounds, intersection: { ...intersection }, scrollTop: ancestor.scrollTop, scrollLeft: ancestor.scrollLeft });
    }
    const fullyInside = visible && rect.width > 0 && rect.height > 0 && ['left', 'right', 'top', 'bottom'].every(edge => Math.abs(rect[edge] - intersection[edge]) <= .5);
    return { at: performance.now(), id, future: !!future, present: !!node, basis: future ? { column: 'e', row: 'k', dependency: 'c' } : null, rect, viewport, clips, intersection, fullyInside };
  }, subject);
  assert(proof.fullyInside, `Subject outside viewport/ancestor clips: ${JSON.stringify(proof)}`);
  return proof;
}
async function capture(q, name, motion = false, subject = null) {
  const settlement = motion ? [] : await settled(q.page);
  const data = await state(q.page), path = join(q.out, `${name}.png`);
  if (!motion && data.visible.includes('dag')) assert(data.nodes.every(n => n.opacity === '1'), 'settled graph is not a transitional blank');
  const beforeScreenshot = subject ? await subjectBounds(q, subject) : null;
  if (q.record.options.elapsedOnly) data.elapsedBeforeScreenshot = await q.page.evaluate(() => window.elapsedSnapshot());
  await q.page.screenshot({ path, animations: 'allow' });
  if (q.record.options.elapsedOnly) data.elapsedAfterScreenshot = await q.page.evaluate(() => window.elapsedSnapshot());
  if (subject) data.subject = { beforeScreenshot, afterScreenshot: await subjectBounds(q, subject) };
  q.manifest.push({ name: `${name}.png`, sha256: sha(readFileSync(path)), fixture: q.record.id, url: q.record.url, options: q.record.options, motion, settlement, state: data, actionCount: q.record.actions.length, sourceIdentity: q.identityHash });
  return data;
}
async function graphScroll(q, target) {
  const graph = q.page.locator('.th-activity-graph');
  const before = await graph.evaluate(e => ({ left: e.scrollLeft, max: e.scrollWidth - e.clientWidth }));
  const goal = Math.min(target, before.max);
  if (Math.abs(goal - before.left) >= 1) {
    await graph.evaluate(e => {
      window.qaPending = new Promise((done, fail) => {
        const timer = setTimeout(() => { cleanup(); fail(new Error('Graph horizontal scrollend deadline')); }, 8000);
        function cleanup() { clearTimeout(timer); e.removeEventListener('scrollend', ended); }
        function ended(event) { if (event.target !== e) return; cleanup(); done(e.scrollLeft); }
        e.addEventListener('scrollend', ended);
      });
    });
    const box = await graph.boundingBox(); await q.page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 40));
    await q.page.mouse.wheel(goal - before.left, 0); await complete(q.page);
  }
  const after = await graph.evaluate(e => ({ left: e.scrollLeft, max: e.scrollWidth - e.clientWidth }));
  assert(Math.abs(after.left - goal) <= 1); q.record.actions.push({ action: 'graph-scroll', target, before, after }); return after;
}
async function geometry(q) {
  return q.page.evaluate(() => [...document.querySelectorAll('.th-activity-gnode')].map(node => {
    const box = e => { const b = e.getBBox(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
    return { id: node.dataset.node, rect: box(node.querySelector('rect')), glyph: node.querySelector('.th-activity-gstatus') ? box(node.querySelector('.th-activity-gstatus')) : null,
      texts: [...node.querySelectorAll('.th-activity-glabel,.th-activity-gstate')].map(e => {
        const ref = e.getAttribute('clip-path'), clip = ref ? document.getElementById(ref.slice(5, -1)) : null;
        return { text: e.textContent, font: getComputedStyle(e).font, box: box(e), clip: clip ? [...clip.children].map(box) : [] };
      }) };
  }));
}
function assertGeometry(nodes) {
  assert(nodes.length > 0);
  for (const node of nodes) {
    assert(node.texts.length >= 2, `${node.id}: visible title and state`);
    for (const [index, text] of node.texts.entries()) {
      const b = text.box;
      assert(b.y >= 0 && b.y + b.height <= node.rect.height + .5, `${node.id}: text stays in node ${JSON.stringify(text)}`);
      assert(b.x + b.width <= node.rect.width - 4, `${node.id}: measured glyph width fits`);
      if (index) { const p = node.texts[index - 1].box; assert(p.y + p.height <= b.y + .5, `${node.id}: rows overlap`); }
      if (index === 0 && node.glyph) {
        assert.equal(text.clip.length, 1, 'first-line clip must not be a union');
        assert(text.clip[0].x + text.clip[0].width <= node.glyph.x - 2, 'clip clears actual glyph');
        assert(b.x + b.width <= node.glyph.x - 2, 'first-line text clears glyph');
      }
    }
  }
}
async function portClosed(port) {
  const socket = connect({ host: '127.0.0.1', port });
  try { await once(socket, 'connect'); throw new Error(`Fixture port ${port} still listening`); }
  catch (error) { if (error.code !== 'ECONNREFUSED') throw error; return error.code; }
  finally { socket.destroy(); }
}
async function session(browser, receipt, options, body) {
  const fixture = startFixture({ port: 0, layout: options.layout ?? 'single', shelves: true, longLabels: options.longLabels ?? false });
  const record = { id: receipt.fixtures.length, options: { viewport: { width: 1280, height: 800 }, theme: 'dark', lang: 'en', fontSize: 13, layout: 'single', reduced: false, ...options }, url: fixture.url, navigation: [], actions: [], assets: [], errors: [], cleanup: {}, traffic: fixture.traffic };
  receipt.fixtures.push(record);
  let context, page;
  const assets = [];
  try {
    context = await browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 800 }, reducedMotion: options.reduced ? 'reduce' : 'no-preference' });
    page = await context.newPage(); page.setDefaultTimeout(8000);
    page.on('pageerror', e => record.errors.push(String(e)));
    page.on('response', response => {
      if (response.request().resourceType() === 'document' || /\.(js|css)$/.test(new URL(response.url()).pathname)) assets.push((async () => {
        const bytes = await response.body(), path = new URL(response.url()).pathname;
        const disk = `frontend/dist/${path === '/' ? 'index.html' : path.slice(1)}`;
        const item = { url: response.url(), status: response.status(), sha256: sha(bytes), disk, diskHash: sha(readFileSync(join(ROOT, disk))) };
        record.assets.push(item); assert.equal(item.sha256, item.diskHash, 'served asset identity');
      })());
    });
    const seeds = seed();
    if (options.elapsedOnly) seeds.tasks[0].created_at = new Date(Date.now() - 5000).toISOString();
    const history = options.history ?? seeds.history;
    record.seed = structuredClone({ history, todo: options.noTodo ? null : seeds.todo });
    await page.route('**/chats/*/activity', route => route.fulfill({ json: { history } }));
    // Browser-side readiness is installed before navigation. No wire request that
    // might have happened before a listener is used as an attachment proxy.
    await page.addInitScript(({ theme, lang, fontSize }) => {
      localStorage.setItem('th-lang', lang); localStorage.setItem('th-theme', theme);
      localStorage.setItem('th-ws-expanded', '["ws"]'); localStorage.setItem('th-font-size', String(fontSize));
      window.activitySignals = { pending: 0, subscribed: 0, cleaned: 0 };
      window.qaSignal = predicate => new Promise((done, fail) => {
        const observer = new MutationObserver(check), resize = new ResizeObserver(check);
        let active = true;
        window.activitySignals.pending++; window.activitySignals.subscribed++;
        const timer = setTimeout(() => { cleanup(); fail(new Error('Activity state deadline')); }, 8000);
        function cleanup() { if (!active) return; active = false; clearTimeout(timer); observer.disconnect(); resize.disconnect(); window.activitySignals.pending--; window.activitySignals.cleaned++; }
        function check() { if (!active) return; try { if (predicate()) { cleanup(); done(true); } } catch (error) { cleanup(); fail(error); } }
        observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        if (document.documentElement) resize.observe(document.documentElement);
        check();
      });
      window.activityReady = window.qaSignal(() => document.querySelector('.th-activity-shelf') && document.querySelector('.th-goal-bar'));
    }, { theme: options.theme ?? 'dark', lang: options.lang ?? 'en', fontSize: options.fontSize ?? 13 });
    const q = { page, context, fixture, seeds, record, out: receipt.out, manifest: receipt.manifest, identityHash: receipt.identityHash };
    q.reload = async () => {
      record.navigation.push({ url: fixture.url, at: new Date().toISOString() }); console.log(`navigate ${fixture.url}`);
      await page.goto(fixture.url); await page.evaluate(() => window.activityReady);
      if (!options.noTodo) {
        await arm(page, () => document.querySelector('.th-activity-shelf .th-activity-bar')?.textContent.includes('32'));
        fixture.deliver('stored-a', { type: 'tool', toolCallId: 'r2-todo', toolName: 'todo', phase: 'end', result: { details: { phases: seeds.todo } } });
        await complete(page);
      }
      if (options.paneWidth) {
        const paneWidth = await page.locator('.th-chat-pane').evaluate(e => e.getBoundingClientRect().width);
        const divider = page.locator('.th-divider'), box = await divider.boundingBox();
        assert(box, 'desktop divider is present');
        await arm(page, new Function(`return Math.abs(document.querySelector('.th-chat-pane').getBoundingClientRect().width - ${options.paneWidth}) <= 1`));
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + options.paneWidth - paneWidth, box.y + box.height / 2); await page.mouse.up(); await complete(page);
        record.actions.push({ action: 'actual-pane-resize', before: paneWidth, target: options.paneWidth, state: await state(page) });
      }
    };
    await q.reload();
    record.result = await body(q);
    assert.notEqual(record.result, undefined, 'scenario returns real data');
    assert.deepEqual(record.errors, [], 'page errors');
  } catch (error) { record.failure = String(error.stack ?? error); throw error; }
  finally {
    const errors = [];
    if (page && !page.isClosed()) {
      try {
        record.cleanup.signals = await page.evaluate(() => window.activitySignals);
        assert.equal(record.cleanup.signals.pending, 0, 'all armed state subscriptions released');
        assert.equal(record.cleanup.signals.subscribed, record.cleanup.signals.cleaned);
        await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: null }); record.cleanup.emulationRestored = true;
      } catch (e) { errors.push(e); }
    }
    if (context) {
      try { const closed = once(context, 'close'); await context.close(); await closed; record.cleanup.contextClosed = context.pages().length === 0; } catch (e) { errors.push(e); }
    }
    try { await Promise.all(assets); } catch (e) { errors.push(e); }
    try { record.cleanup.fixture = await fixture.stop(); record.cleanup.portClosed = await portClosed(Number(new URL(fixture.url).port)); } catch (e) { errors.push(e); }
    record.cleanup.errors = errors.map(String);
    if (errors.length) throw new AggregateError(errors, 'Activity cleanup failed');
  }
}
async function tabs(q) {
  const initial = await state(q.page);
  assert.deepEqual(initial.tabs.map(t => t.id), ['todo', 'agents', 'dag']);
  assert.equal(initial.tabs.find(t => t.selected === 'true').id, 'todo');
  assert.deepEqual(initial.tabs.map(t => t.count), ['1/32', '3/8', '2/6']);
  for (const id of ['todo', 'agents', 'dag']) {
    await select(q, id); const s = await capture(q, `tab-${id}`);
    assert.deepEqual(s.visible, [id]); assert(Math.max(...s.tabs.map(t => t.rect.width)) - Math.min(...s.tabs.map(t => t.rect.width)) <= 1);
  }
  await changeView(q, 'list'); await select(q, 'todo'); await select(q, 'dag');
  assert.equal(await q.page.locator(view('list')).getAttribute('aria-pressed'), 'true');
  await click(q, fold, () => !document.querySelector('.th-activity-panel'));
  assert.equal((await state(q.page)).tabs.length, 3);
  await click(q, fold, () => !!document.querySelector('.th-activity-panel'));
  assert.equal(await q.page.locator(view('list')).getAttribute('aria-pressed'), 'true');
  for (const [key, id] of [['Home', 'todo'], ['ArrowRight', 'agents'], ['End', 'dag'], ['ArrowLeft', 'agents'], ['ArrowDown', 'dag'], ['ArrowUp', 'agents']]) {
    await q.page.locator('[data-activity-tab][aria-selected="true"]').focus();
    await arm(q.page, new Function(`return document.activeElement?.getAttribute('data-activity-tab') === '${id}'`));
    await q.page.keyboard.press(key); await complete(q.page);
    q.record.actions.push({ action: 'tab-key', key, state: await state(q.page) });
  }
  await select(q, 'dag');
  await arm(q.page, () => document.querySelector('[data-activity-tab="agents"] .th-activity-tab-count')?.textContent === '4/9');
  q.fixture.deliver('stored-a', { type: 'extensionEvent', name: 'omo.task.updated', data: { parent_session_id: 'qa', truncated_tasks: false, tasks: [...q.seeds.tasks, { task_id: 'new', name: 'Live addition', status: 'running' }] } });
  await complete(q.page); assert.deepEqual((await state(q.page)).visible, ['dag']);
  return { initial, final: await state(q.page) };
}
async function resize(q) {
  await open(q); const grip = q.page.locator('.th-activity-resize');
  await grip.focus();
  for (const [key, value] of [['Home', '120'], ['ArrowUp', '144'], ['ArrowDown', '120'], ['End', '480'], ['Home', '120']]) {
    await arm(q.page, new Function(`return document.querySelector('.th-activity-resize')?.getAttribute('aria-valuenow') === '${value}'`));
    await q.page.keyboard.press(key); await complete(q.page);
    assert.equal((await state(q.page)).stored, value);
    q.record.actions.push({ action: 'resize-key', key, state: await state(q.page) });
  }
  const box = await grip.boundingBox();
  await q.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await q.page.mouse.down();
  for (const delta of [20, 40, 60, 80]) {
    await arm(q.page, new Function(`return document.querySelector('.th-activity-panel')?.getBoundingClientRect().height === ${120 + delta}`));
    await q.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - delta); await complete(q.page);
    const s = await capture(q, `drag-${delta}`); assert.equal(s.activity.height, 120 + delta);
    q.record.actions.push({ action: 'drag-intermediate', delta, state: s });
  }
  await q.page.mouse.up(); await q.reload(); await open(q);
  assert.equal((await state(q.page)).stored, '200'); assert.equal((await state(q.page)).activity.height, 200);
  await capture(q, 'stored-height-reload');
  await arm(q.page, () => !document.querySelector('.th-activity-panel--sized'));
  await q.page.locator('.th-activity-resize').dblclick(); await complete(q.page);
  assert.equal((await state(q.page)).stored, null);
  return state(q.page);
}
async function allocation(q, name) {
  await click(q, '.th-goal-bar', () => document.querySelector('.th-goal-shelf')?.style.flexShrink === '0');
  await click(q, fold, () => document.querySelector('.th-activity-shelf')?.style.flexShrink === '0');
  const s = await capture(q, name);
  assert(s.goalIntent && s.activityIntent); assert(s.tabs.every(t => t.rect.height > 0));
  assert(s.composer.bottom <= q.record.options.viewport.height + 1); assert(!s.overflow);
  // Both allocators reserve the transcript before distributing usable panels.
  if (s.usable >= 120) assert(s.transcript.height >= 119, `120px reserve: ${s.transcript.height}, usable=${s.usable}`);
  else assert(s.transcript.height >= 0 && !s.activity && !s.goal, 'no usable panel when the reserve exhausts the budget');
  if (s.activity) assert(s.activity.height <= Number.parseFloat(s.panelMax) + 1);
  if (name.includes('340')) assert(Math.abs(s.pane.width - 340) <= 1, `actual pane width ${s.pane.width}`);
  return s;
}
async function motionArm(q, id, name, interrupt, hold = false) {
  await q.page.evaluate(({ id, name, interrupt, hold }) => {
    window.motionEvents = [];
    window.motionSignal = new Promise((done, fail) => {
      let target;
      const timer = setTimeout(() => { cleanup(); fail(new Error(`Motion event deadline ${id}/${name}: ${JSON.stringify(window.motionEvents)}`)); }, 8000);
      function cleanup() { clearTimeout(timer); document.removeEventListener('animationstart', listener, true); target?.removeEventListener('animationcancel', listener); }
      function listener(e) {
        if (e.target?.getAttribute?.('data-node') !== id || e.animationName !== name) return;
        window.motionEvents.push({ type: e.type, name, id, at: performance.now(), elapsed: e.elapsedTime });
        if (e.type === 'animationstart') {
          target = e.target;
          if (interrupt && !hold) { target.addEventListener('animationcancel', listener); document.querySelector(interrupt).click(); }
          else {
            window.motionAnimation = e.target.getAnimations().find(a => a.animationName === name);
            window.motionAnimation.pause(); cleanup(); done(window.motionEvents);
          }
        } else if (interrupt && e.type === 'animationcancel') { cleanup(); done(window.motionEvents); }
      }
      document.addEventListener('animationstart', listener, true);
    });
  }, { id, name, interrupt, hold });
}
function deliverDag(q, run) {
  q.revision = Math.max(Date.now(), (q.revision ?? Date.parse(q.seeds.run.updated_at)) + 1);
  run.updated_at = new Date(q.revision).toISOString();
  q.record.actions.push({ action: 'dag-frame', run: structuredClone(run) });
  q.fixture.deliver('stored-a', { type: 'extensionEvent', name: 'omo.dag.updated', data: { parent_session_id: 'qa', truncated_runs: false, runs: [run] } });
}
async function motion(q, interruption = null) {
  await select(q, 'dag'); await settled(q.page);
  const base = q.seeds.run, data = [];
  if (!interruption) {
    await capture(q, 'motion-running-before', true);
    // Sample actual consecutive compositor frames; time is the behavior under test.
    const running = await q.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
      const a = document.getAnimations().find(a => a.animationName === 'th-dag-run-spin');
      const before = { time: a.currentTime, transform: getComputedStyle(a.effect.target).transform };
      requestAnimationFrame(() => { const during = { time: a.currentTime, transform: getComputedStyle(a.effect.target).transform }; a.pause(); window.runningAnimation = a; resolve({ before, during }); });
    })));
    assert(running.during.time > running.before.time); assert.notEqual(running.during.transform, running.before.transform);
    await capture(q, 'motion-running-during', true); await q.page.evaluate(() => window.runningAnimation.play()); await capture(q, 'motion-running-after', true); data.push(running);
    for (const [id, status] of [['c', 'completed'], ['e', 'failed'], ['new', 'running']]) {
      await capture(q, `motion-${id}-before`);
      const run = { ...base, updated_at: new Date().toISOString(), nodes: id === 'new' ? [...base.nodes, { id, label: 'New entry', prompt: 'New entry', depends_on: ['b'], state: status }] : base.nodes.map(n => n.id === id ? { ...n, state: status } : n) };
      const name = id === 'new' ? 'th-dag-node-enter' : 'th-dag-node-settle';
      await motionArm(q, id, name); deliverDag(q, run);
      const events = await q.page.evaluate(() => window.motionSignal);
      await capture(q, `motion-${id}-during`, true);
      const end = await q.page.evaluate(async () => {
        const a = window.motionAnimation; let timer;
        const event = new Promise((done, fail) => {
          const target = a.effect.target;
          function ended(e) { if (e.animationName !== a.animationName || e.target !== target) return; clearTimeout(timer); target.removeEventListener('animationend', ended); done({ type: e.type, name: e.animationName, at: performance.now(), elapsed: e.elapsedTime }); }
          target.addEventListener('animationend', ended);
          timer = setTimeout(() => { target.removeEventListener('animationend', ended); fail(new Error('Motion end deadline')); }, 8000);
        });
        a.play(); return event;
      });
      await capture(q, `motion-${id}-after`); data.push({ id, events, end });
      Object.assign(base, run);
    }
    const handles = await q.page.locator('.th-activity-gnode').elementHandles();
    const before = await state(q.page);
    await arm(q.page, () => document.querySelector('.th-activity-partial') !== null);
    q.fixture.deliver('stored-a', { type: 'extensionEvent', name: 'omo.dag.updated', data: { parent_session_id: 'qa', truncated_runs: true, runs: [{ ...base, updated_at: new Date().toISOString() }] } });
    await complete(q.page);
    assert.deepEqual((await state(q.page)).nodes.map(n => n.transform), before.nodes.map(n => n.transform));
    for (const handle of handles) { assert(await handle.evaluate(e => e === document.querySelector(`[data-node="${e.dataset.node}"]`))); await handle.dispose(); }
  } else {
    // Every interruption has its own browser context and unchanged six-node seed.
    const { switchName, terminal } = interruption;
    const selector = { tab: tab('todo'), fold, list: view('list') }[switchName];
    {
      const id = terminal ? 'c' : `new-${switchName}`;
      const running = { ...base, nodes: base.nodes.map(n => n.id === 'c' ? { ...n, state: 'running' } : n), updated_at: new Date().toISOString() };
      await arm(q.page, () => document.querySelector('[data-node="c"]')?.classList.contains('th-activity-gnode--running'));
      deliverDag(q, running); await complete(q.page); await settled(q.page);
      const next = { ...running, nodes: terminal ? running.nodes.map(n => n.id === id ? { ...n, state: 'completed' } : n) : [...running.nodes, { id, label: 'Interrupted entry', prompt: 'Interrupted entry', depends_on: ['c'], state: 'running' }] };
      const before = await capture(q, `interrupt-${switchName}-${terminal}-before`, false, { id, future: !terminal });
      await motionArm(q, id, terminal ? 'th-dag-node-settle' : 'th-dag-node-enter', selector, true);
      deliverDag(q, next); const events = await q.page.evaluate(() => window.motionSignal);
      const during = await capture(q, `interrupt-${switchName}-${terminal}-during`, true, { id });
      assert.deepEqual(during.subject.beforeScreenshot.rect, before.subject.afterScreenshot.rect, 'actual subject occupies its captured before/future position');
      const cancel = await q.page.evaluate(selector => new Promise((done, fail) => {
        const a = window.motionAnimation, target = a.effect.target;
        const timer = setTimeout(() => { target.removeEventListener('animationcancel', cancelled); fail(new Error('Interrupted animation cancel deadline')); }, 8000);
        function cancelled(e) { if (e.animationName !== a.animationName) return; clearTimeout(timer); target.removeEventListener('animationcancel', cancelled); done({ type: e.type, name: e.animationName, at: performance.now(), elapsed: e.elapsedTime }); }
        target.addEventListener('animationcancel', cancelled);
        a.play(); requestAnimationFrame(() => document.querySelector(selector).click());
      }), selector);
      events.push(cancel);
      q.record.actions.push({ action: 'interruption-events', switchName, terminal, events });
      const hidden = await capture(q, `interrupt-${switchName}-${terminal}-hidden`, true);
      assert.equal(hidden.animations.filter(a => /th-dag/.test(a.name)).length, 0);
      await q.page.evaluate(() => {
        window.returnStarts = [];
        window.returnListener = e => { if (/^th-dag-node-(enter|settle)$/.test(e.animationName)) window.returnStarts.push({ name: e.animationName, id: e.target.getAttribute('data-node'), at: performance.now() }); };
        document.addEventListener('animationstart', window.returnListener, true);
      });
      if (switchName === 'fold') await click(q, fold, () => !!document.querySelector('.th-activity-panel'));
      if (switchName === 'tab') await select(q, 'dag');
      if (switchName === 'list') await changeView(q, 'graph');
      const returned = await state(q.page);
      assert(!returned.animations.some(a => a.node === id && /enter|settle/.test(a.name)), `interrupted motion replay ${switchName}/${terminal}`);
      const returnFrame = await capture(q, `interrupt-${switchName}-${terminal}-return`, false, { id });
      const returnStarts = await q.page.evaluate(() => { document.removeEventListener('animationstart', window.returnListener, true); return window.returnStarts; });
      assert.deepEqual(returnStarts, [], 'return must not restart any one-shot animation');
      assert.deepEqual(returnFrame.subject.beforeScreenshot.rect, before.subject.afterScreenshot.rect, 'return position is stable');
      data.push({ switchName, terminal, events, before, during, hidden, returned, returnFrame, returnStarts });
    }
  }
  await select(q, 'todo'); const hidden = await state(q.page);
  assert(hidden.nodes.length > 0); assert.equal(hidden.animations.filter(a => /th-dag/.test(a.name)).length, 0);
  const hiddenName = !interruption ? 'normal' : interruption.switchName === 'tab' && !interruption.terminal ? 'interrupt' : `interrupt-${interruption.switchName}-${interruption.terminal}`;
  await capture(q, `motion-${hiddenName}-mounted-hidden`);
  return { data, hidden };
}

async function elapsedOnly(q) {
  await select(q, 'dag'); await settled(q.page);
  const actionStart = q.record.actions.length, trafficStart = q.fixture.traffic.length;
  await q.page.evaluate(({ taskName, runId }) => {
    const row = [...document.querySelectorAll('.th-activity-agent')].find(e => e.querySelector('.th-activity-agent-name')?.textContent === taskName);
    const label = row?.querySelector('.th-activity-agent-meta:not(.th-activity-agent-turns):not(.th-activity-agent-toolcalls):not(.th-activity-agent-rate):not(.th-activity-quiet-note)');
    if (!label) throw new Error('Elapsed subject is absent');
    const ids = new WeakMap(); let serial = 0;
    const identity = element => { if (!ids.has(element)) ids.set(element, ++serial); return ids.get(element); };
    window.elapsedStarts = [];
    window.elapsedListener = e => {
      if (e.target.closest?.('.th-activity-shelf')) window.elapsedStarts.push({ name: e.animationName, node: e.target.closest('[data-node]')?.dataset.node ?? null, at: performance.now(), elapsed: e.elapsedTime });
    };
    window.elapsedSnapshot = () => ({
      at: performance.now(), label: label.textContent, labelIdentity: identity(label), labelConnected: label.isConnected,
      agentsHidden: row.closest('[data-activity-tabpanel]').hidden,
      dagVisible: !document.querySelector('[data-activity-tabpanel="dag"]').hidden,
      runs: [...document.querySelectorAll('.th-activity-dag')].map(e => ({ runId, identity: identity(e), rect: e.getBoundingClientRect().toJSON() })),
      nodes: [...document.querySelectorAll('.th-activity-gnode')].map(e => ({ id: e.dataset.node, identity: identity(e), transform: e.getAttribute('transform'), rect: e.getBoundingClientRect().toJSON() })),
      animations: document.getAnimations().filter(a => a.effect?.target?.closest?.('.th-activity-shelf')).map(a => ({ name: a.animationName ?? a.transitionProperty, time: a.currentTime, playState: a.playState, node: a.effect.target.closest('[data-node]')?.dataset.node ?? null })),
      starts: [...window.elapsedStarts],
    });
    window.awaitElapsedMutation = () => new Promise((done, fail) => {
      const before = window.elapsedSnapshot(); let frame;
      const observer = new MutationObserver(() => {
        if (label.textContent === before.label) return;
        const mutation = window.elapsedSnapshot(); observer.disconnect();
        // Observe the native animation frame after React's timer-driven render,
        // so animationstart dispatch cannot trail our no-replay assertion.
        frame = requestAnimationFrame(() => { cleanup(); done({ before, mutation, afterFrame: window.elapsedSnapshot() }); });
      });
      const timer = setTimeout(() => { cleanup(); fail(new Error('Actual elapsed-label mutation deadline')); }, 8000);
      function cleanup() { clearTimeout(timer); cancelAnimationFrame(frame); observer.disconnect(); }
      observer.observe(label, { subtree: true, childList: true, characterData: true });
    });
    document.addEventListener('animationstart', window.elapsedListener, true);
  }, { taskName: q.seeds.tasks[0].name, runId: q.seeds.run.run_id });
  try {
    const before = await capture(q, 'elapsed-only-before', true);
    // No fixture action, clock override, or DAG update triggers this signal.
    const tick = await q.page.evaluate(() => window.awaitElapsedMutation());
    const after = await capture(q, 'elapsed-only-after', true);
    const frames = [before.elapsedBeforeScreenshot, before.elapsedAfterScreenshot, tick.before, tick.mutation, tick.afterFrame, after.elapsedBeforeScreenshot, after.elapsedAfterScreenshot];
    for (const frame of frames) {
      assert(frame.agentsHidden && frame.dagVisible && frame.labelConnected);
      assert.equal(frame.labelIdentity, frames[0].labelIdentity);
      assert.deepEqual(frame.runs, frames[0].runs, 'elapsed tick preserves run DOM and position');
      assert.deepEqual(frame.nodes, frames[0].nodes, 'elapsed tick preserves node DOM and positions');
      assert.equal(frame.nodes.length, q.seeds.run.nodes.length);
      assert(!frame.animations.some(a => /^th-dag-node-(enter|settle)$/.test(a.name)), 'elapsed tick must not replay one-shot motion');
      assert(!frame.starts.some(a => /^th-dag-node-(enter|settle)$/.test(a.name)), 'no one-shot animationstart across elapsed capture');
    }
    assert.notEqual(tick.before.label, tick.mutation.label, 'real elapsed text changed');
    assert.equal(q.record.actions.length, actionStart, 'no fixture action during elapsed observation');
    const traffic = structuredClone(q.fixture.traffic.slice(trafficStart));
    assert(!traffic.some(e => e.frame?.name === 'omo.dag.updated' || e.frame?.name === 'omo.task.updated'), 'no activity data update substitutes for elapsed time');
    const result = { before, tick, after, traffic, actionStart, actionEnd: q.record.actions.length };
    q.record.actions.push({ action: 'native-elapsed-only', tick, traffic });
    return result;
  } finally {
    await q.page.evaluate(() => document.removeEventListener('animationstart', window.elapsedListener, true));
    q.record.cleanup.elapsedListenerRemoved = true;
  }
}

/** Derived navigation aids, never additional SPA evidence or a visual verdict. */
async function contactSheets(browser, receipt) {
  const context = await browser.newContext({ viewport: { width: 1140, height: 960 } });
  receipt.contacts = { pages: [], contextClosed: false };
  try {
    const page = await context.newPage();
    for (let offset = 0; offset < receipt.manifest.length; offset += 9) {
      const items = receipt.manifest.slice(offset, offset + 9);
      await page.setContent(`<html><head><style>body{margin:0;background:#eee;color:#111;font:14px monospace;display:grid;grid-template-columns:repeat(3,380px)}figure{margin:0;padding:8px;height:304px;box-sizing:border-box}img{display:block;max-width:364px;height:266px;object-fit:contain;margin:auto}figcaption{overflow-wrap:anywhere}</style></head><body>${items.map((item, i) => `<figure><img src="data:image/png;base64,${readFileSync(join(receipt.out, item.name)).toString('base64')}"><figcaption>${offset + i + 1}. ${item.name}</figcaption></figure>`).join('')}</body></html>`);
      await page.evaluate(async () => { await Promise.all([...document.images].map(image => image.decode())); });
      const name = `contact-${String(offset / 9 + 1).padStart(2, '0')}.png`;
      await page.screenshot({ path: join(receipt.out, name) });
      receipt.contacts.pages.push({ name, sha256: sha(readFileSync(join(receipt.out, name))), items: items.map((item, i) => ({ index: offset + i + 1, name: item.name, sha256: item.sha256 })) });
    }
  } finally {
    const closed = once(context, 'close'); await context.close(); await closed;
    receipt.contacts.contextClosed = context.pages().length === 0;
  }
}

export async function run({ phase = 'green', out, qaPlaywright = DRIVER } = {}) {
  assert(['baseline', 'regression', 'green'].includes(phase)); assert(out);
  out = resolve(out); mkdirSync(out, { recursive: true });
  const receipt = { phase, out, command: `bun test/qa/ui-followup-activity.mjs --phase ${phase} --out ${out}`, startedAt: new Date().toISOString(), identity: await identity(), fixtures: [], scenarios: [], manifest: [] };
  receipt.identityHash = sha(JSON.stringify(receipt.identity));
  writeFileSync(join(out, 'inventory.json'), JSON.stringify({ phase, groups: ['tabs', 'empty-three', 'initial', 'history-freshness', 'scroll', 'resize-reload', 'shared-hooks', 'allocation-4', 'geometry-8', 'motion', 'interruption-6-independent', 'elapsed-only', 'reduced'], command: receipt.command, identity: receipt.identity }, null, 2));
  const { chromium } = await import(qaPlaywright), browser = await chromium.launch({ channel: 'chrome', headless: true });
  async function scenario(name, options, body) {
    const entry = { name, options, fixtures: [] }; receipt.scenarios.push(entry); const start = receipt.fixtures.length;
    try { await session(browser, receipt, options, body); entry.ok = true; }
    catch (error) { entry.ok = false; entry.error = String(error.stack ?? error); }
    entry.fixtures = receipt.fixtures.slice(start).map(r => r.id);
    console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${name}${entry.error ? ': ' + entry.error.split('\n')[0] : ''}`);
  }
  try {
    if (phase === 'baseline') {
      await scenario('new-baseline-old-ui', {}, async q => {
        const before = await capture(q, 'baseline-collapsed');
        await click(q, '.th-activity-shelf button.th-activity-bar', () => !!document.querySelector('.th-activity-panel'));
        const listDefault = await q.page.locator('.th-activity-dagnodes').count() > 0;
        await capture(q, 'baseline-mixed-list');
        await changeView(q, 'graph'); await capture(q, 'baseline-old-graph');
        const observed = await state(q.page);
        const failures = { permanentTabs: before.tabs.length !== 3, graphDefault: listDefault, visibleStates: await q.page.locator('.th-activity-gstate').count() === 0, runningMotion: observed.animations.length === 0 };
        assert(failures.permanentTabs && failures.visibleStates && failures.runningMotion);
        return { before, observed, failures };
      });
    } else if (phase === 'regression') {
      for (const lang of ['en', 'ko']) await scenario(`font24-${lang}`, { lang, fontSize: 24 }, async q => { await select(q, 'dag'); await capture(q, `regression-${lang}-font24`); const nodes = await geometry(q); q.record.geometry = nodes; assertGeometry(nodes); return nodes; });
      for (const item of interruptionCases) await scenario(`interrupted-motion-${item.switchName}-${item.terminal ? 'terminal' : 'entry'}`, {}, q => motion(q, item));
      await scenario('shared-hooks', {}, async q => ({ actions: await exerciseShelves(q, name => capture(q, `shared-${name}`)) }));
    } else {
      await scenario('tabs', {}, tabs);
      const s = seed();
      for (const id of ['todo', 'agents', 'dag']) await scenario(`empty-${id}`, { noTodo: true, history: { task: { parent_session_id: 'qa', truncated_tasks: true, tasks: [] }, dag: null } }, async q => { await select(q, id); assert.equal(await q.page.locator(`${panel(id)} .th-activity-empty`).count(), 1); return capture(q, `empty-${id}`); });
      await scenario('initial-agents', { noTodo: true }, async q => { const s = await state(q.page); assert.equal(s.tabs.find(t => t.selected === 'true').id, 'agents'); await select(q, 'agents'); return capture(q, 'initial-agents'); });
      await scenario('history-freshness', { noTodo: true, history: { task: { ...s.history.task, truncated_tasks: true, tasks: s.tasks.map(t => ({ ...t, updated_at: new Date(Date.now() - 600000).toISOString() })) }, dag: { ...s.history.dag, truncated_runs: true, runs: [s.run, { ...s.run, run_id: 'historical', run_key: 'old', name: 'Completed history', status: 'completed' }] } } }, async q => {
        await select(q, 'dag'); assert.equal(await q.page.locator('.th-activity-dag').count(), 2); await capture(q, 'partial-multiple-dags');
        await select(q, 'agents');
        await arm(q.page, () => document.querySelectorAll('.th-activity-quiet-note').length > 0);
        q.fixture.deliver('stored-a', { type: 'run.started' }); await complete(q.page);
        const before = await capture(q, 'freshness-before');
        await arm(q.page, () => [...document.querySelectorAll('.th-activity-agent-tool')].some(e => e.textContent === 'updated-tool'));
        q.fixture.deliver('stored-a', { type: 'extensionEvent', name: 'omo.task.updated', data: { ...q.seeds.history.task, tasks: q.seeds.tasks.map(t => t.task_id === 'direct' ? { ...t, updated_at: new Date().toISOString(), live_progress: { ...t.live_progress, current_tool: 'updated-tool' } } : t) } }); await complete(q.page);
        const after = await capture(q, 'freshness-after'); assert.notDeepEqual(before.freshness, after.freshness);
        await arm(q.page, () => document.querySelectorAll('.th-activity-quiet-note').length === 0);
        q.fixture.deliver('stored-a', { type: 'run.done', reason: 'stop' }); await complete(q.page);
        return { before, after, idle: await capture(q, 'freshness-idle') };
      });
      await scenario('scroll', { history: { ...s.history, task: { ...s.history.task, tasks: Array.from({ length: 35 }, (_, i) => ({ ...s.tasks[0], task_id: `task-${i}` })) }, dag: { ...s.history.dag, runs: Array.from({ length: 8 }, (_, i) => ({ ...s.run, run_id: `run-${i}`, run_key: `key-${i}` })) } } }, async q => {
        const data = [];
        for (const id of ['todo', 'agents', 'dag']) { await select(q, id); const owner = q.page.locator(panel(id)); await wheel(q.page, owner, 160, true); const before = await owner.evaluate(e => e.scrollTop); assert(before > 0); await capture(q, `scroll-${id}-before`); await select(q, id === 'todo' ? 'agents' : 'todo'); await select(q, id); const after = await owner.evaluate(e => e.scrollTop); assert.equal(after, before); await capture(q, `scroll-${id}-return`); data.push({ id, before, after }); }
        return data;
      });
      await scenario('resize-reload', {}, resize);
      await scenario('font-settings-live', {}, async q => {
        await select(q, 'dag'); const before = await geometry(q);
        const handle = await q.page.locator('[data-node="a"]').elementHandle();
        await capture(q, 'font-live-13');
        await click(q, '.th-settings-menu > button', () => !!document.querySelector('.th-settings-panel'));
        for (let size = 14; size <= 24; size++) {
          await arm(q.page, new Function(`return document.querySelector('.th-settings-size-value')?.textContent === '${size}px'`));
          await q.page.locator('.th-settings-size-btn').last().click(); await complete(q.page);
        }
        await arm(q.page, () => !document.querySelector('.th-settings-panel'));
        await q.page.keyboard.press('Escape'); await complete(q.page);
        const after = await geometry(q); assertGeometry(after); assert(after[0].rect.width > before[0].rect.width);
        assert(await handle.evaluate(e => e === document.querySelector('[data-node="a"]'))); await handle.dispose();
        await capture(q, 'font-live-24'); return { before, after };
      });
      await scenario('goal-hover-summary-readonly', {}, async q => {
        const paint = () => q.page.evaluate(() => { const style = s => { const e = document.querySelector(s), c = getComputedStyle(e); return { tag: e.tagName, background: c.backgroundColor, border: c.borderColor, color: c.color, cursor: c.cursor }; }; return { goal: style('.th-goal-bar'), summary: style('.th-activity-shelf .th-activity-bar') }; });
        await q.page.mouse.move(0, 0); const before = await paint();
        await q.page.locator('.th-goal-bar').hover();
        await q.page.evaluate(() => Promise.all(document.querySelector('.th-goal-bar').getAnimations().map(a => a.finished)));
        const hovered = await paint(); assert.notEqual(before.goal.background, hovered.goal.background); assert.equal(hovered.goal.cursor, 'pointer');
        await capture(q, 'goal-hover-feedback');
        await q.page.locator('.th-activity-shelf .th-activity-bar').hover();
        const summaryHover = await paint(); assert.deepEqual(summaryHover.summary, before.summary); assert.equal(summaryHover.summary.tag, 'SPAN');
        await capture(q, 'activity-summary-readonly'); return { before, hovered, summaryHover };
      });
      await scenario('shared-hooks', {}, async q => ({ actions: await exerciseShelves(q, name => capture(q, `shared-${name}`)) }));
      for (const [name, viewport, layout] of [['desktop', { width: 1280, height: 800 }, 'single'], ['mobile', { width: 390, height: 844 }, 'single'], ['340', { width: 1280, height: 800 }, 'two'], ['short', { width: 1280, height: 420 }, 'single']]) for (const lang of ['en', 'ko']) for (const fontSize of [13, 24]) {
        const label = `allocation-${name}-${lang}-${fontSize}`;
        await scenario(label, { viewport, layout, lang, fontSize, ...(name === '340' ? { paneWidth: 340 } : {}) }, q => allocation(q, label));
      }
      let shared;
      await shelfRegressionScenarios({
        fixture: { wait: (...args) => shared.fixture.wait(...args) },
        async scenario(name, body) {
          const [, width, height] = /-(\d+)-(\d+)$/.exec(name);
          await scenario(`caller-${name}`, { viewport: { width: Number(width), height: Number(height) }, longLabels: true }, async q => { shared = q; return body(); });
        },
        reset: async () => shared.page,
        arm: predicate => arm(shared.page, predicate), done: () => complete(shared.page),
        shot: name => capture(shared, `caller-${name.replace('.png', '')}`),
      });
      for (const theme of ['dark', 'light']) for (const lang of ['en', 'ko']) for (const fontSize of [13, 24]) {
        const name = `${theme}-${lang}-${fontSize}`;
        await scenario(`geometry-${name}`, { theme, lang, fontSize, viewport: { width: 390, height: 844 } }, async q => {
          await select(q, 'todo'); await capture(q, `${name}-todo`); await select(q, 'agents'); await capture(q, `${name}-agents`); await select(q, 'dag'); await capture(q, `${name}-graph`);
          const nodes = await geometry(q); q.record.geometry = nodes; assertGeometry(nodes);
          assert((await q.page.locator('.th-activity-gedge').evaluateAll(es => es.every(e => e.hasAttribute('marker-end')))));
          for (const layer of [1, 2]) { await graphScroll(q, layer * (nodes[0].rect.width + 24)); await capture(q, `${name}-graph-layer-${layer}`); }
          const reach = await graphScroll(q, 10000);
          await capture(q, `${name}-graph-right`); return { nodes, reach };
        });
      }
      for (const lang of ['en', 'ko']) for (const fontSize of [13, 24]) {
        await scenario(`empty-geometry-${lang}-${fontSize}`, { lang, fontSize, noTodo: true, viewport: { width: 390, height: 844 }, history: { task: { parent_session_id: 'qa', truncated_tasks: true, tasks: [] }, dag: null } }, async q => {
          const data = [];
          for (const id of ['todo', 'agents', 'dag']) { await select(q, id); data.push(await capture(q, `empty-${lang}-${fontSize}-${id}`)); }
          return data;
        });
      }
      await scenario('motion', {}, q => motion(q));
      for (const item of interruptionCases) await scenario(`interruption-${item.switchName}-${item.terminal ? 'terminal' : 'entry'}`, {}, q => motion(q, item));
      await scenario('elapsed-only', { elapsedOnly: true }, elapsedOnly);
      await scenario('reduced', { reduced: true }, async q => { await select(q, 'dag'); const s = await capture(q, 'reduced-motion'); assert.equal(s.animations.length, 0); assert(s.nodes.every(n => n.opacity === '1')); return s; });
    }
    await contactSheets(browser, receipt);
  } finally {
    const disconnected = once(browser, 'disconnected'); await browser.close(); await disconnected;
    receipt.cleanup = { browserClosed: !browser.isConnected(), contexts: browser.contexts().length };
    receipt.finishedAt = new Date().toISOString(); receipt.identityAfter = await identity();
    receipt.pendingWorkZero = receipt.fixtures.every(f => f.cleanup.contextClosed && f.cleanup.fixture?.serverStopped && ['pendingWebSockets', 'pendingOpens', 'pendingCreates'].every(k => f.cleanup.fixture[k] === 0) && f.cleanup.errors.length === 0);
    receipt.sourceStable = JSON.stringify(receipt.identity) === JSON.stringify(receipt.identityAfter);
    receipt.verdict = receipt.scenarios.every(s => s.ok) && receipt.pendingWorkZero && receipt.sourceStable && receipt.cleanup.browserClosed && receipt.cleanup.contexts === 0 && receipt.contacts?.contextClosed ? 'PASS' : 'FAIL';
    writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(receipt.manifest, null, 2));
    writeFileSync(join(out, 'contacts.json'), JSON.stringify(receipt.contacts, null, 2));
    writeFileSync(join(out, 'index.md'), '# Exact capture inventory\n\nContact sheets are derived navigation aids; inspect the named full-size PNG for detail.\n\n' + receipt.manifest.map((item, i) => `${i + 1}. [${item.name}](${item.name}) - fixture ${item.fixture}; ${item.motion ? 'motion frame' : 'settled frame'}; SHA256 ${item.sha256}`).join('\n'));
  }
  if (receipt.verdict !== 'PASS' && phase !== 'regression') throw new Error(`${phase} failed: ${receipt.scenarios.filter(s => !s.ok).map(s => s.name).join(', ')}`);
  return { verdict: receipt.verdict, scenarios: receipt.scenarios.length, failed: receipt.scenarios.filter(s => !s.ok).map(s => s.name), pngs: receipt.manifest.length, out };
}
if (import.meta.main) {
  try { const args = process.argv.slice(2); console.log(await run({ phase: args[args.indexOf('--phase') + 1], out: args[args.indexOf('--out') + 1], qaPlaywright: process.env.QA_PLAYWRIGHT ?? DRIVER })); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
