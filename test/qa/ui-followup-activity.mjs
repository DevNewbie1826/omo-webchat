/** Activity real-SPA acceptance. Baseline is a new run, never historical evidence.
 * bun test/qa/ui-followup-activity.mjs --phase baseline|regression|green --out DIR
 * Inventory: baseline old controls; tabs/counts/empty/keyboard/history/freshness;
 * per-view scroll, List/fold, resize/reload; both-open desktop/mobile/340/short;
 * dark/light x en/ko x font13/24 graph/agents/tabs; directional/horizontal graph;
 * actual entry/completed/failed/running frames, interrupted tab/fold/List,
 * hidden mounted/unmounted and reduced motion. No readiness polling.
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
import { installSignals, arm, complete, wheel } from './design-workbench-fixture.mjs';
import { exerciseShelves } from './design-workbench-controls.mjs';

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
async function state(page) {
  return page.evaluate(() => {
    const box = s => document.querySelector(s)?.getBoundingClientRect().toJSON() ?? null;
    const tabs = [...document.querySelectorAll('[data-activity-tab]')].map(e => ({ id: e.dataset.activityTab, selected: e.getAttribute('aria-selected'), rect: e.getBoundingClientRect().toJSON(), count: e.querySelector('.th-activity-tab-count')?.textContent, display: getComputedStyle(e).display }));
    return { at: performance.now(), tabs, visible: [...document.querySelectorAll('[data-activity-tabpanel]')].filter(e => !e.hidden && e.getClientRects().length).map(e => e.dataset.activityTabpanel),
      pane: box('.th-chat-pane'), column: box('.th-chat-main'), transcript: box('.th-chat-scrollport'), goal: box('.th-goal-panel'), activity: box('.th-activity-panel'), composer: box('.th-chat-input'),
      goalOpen: document.querySelector('.th-goal-bar')?.getAttribute('aria-expanded'), activityOpen: document.querySelector('button.th-activity-fold')?.getAttribute('aria-expanded'),
      goalIntent: !!document.querySelector('.th-goal-shelf .th-activity-caret--open'), activityIntent: !!document.querySelector('.th-activity-shelf .th-activity-caret--open'),
      allocated: [...document.querySelectorAll('.th-goal-shelf,.th-activity-shelf')].map(e => e.style.flexShrink),
      panelMax: document.querySelector('.th-activity-panel')?.style.maxHeight, stored: localStorage.getItem('th-activity-panel-height'),
      scroll: [...document.querySelectorAll('[data-activity-tabpanel],.th-activity-graph')].map(e => ({ owner: e.dataset.activityTabpanel ?? 'graph', top: e.scrollTop, left: e.scrollLeft, height: e.clientHeight, width: e.clientWidth, scrollHeight: e.scrollHeight, scrollWidth: e.scrollWidth })),
      animations: document.getAnimations().filter(a => a.effect?.target?.closest?.('.th-activity-shelf')).map(a => ({ name: a.animationName, time: a.currentTime, playState: a.playState, node: a.effect.target.closest('[data-node]')?.dataset.node, transform: getComputedStyle(a.effect.target).transform })),
      nodes: [...document.querySelectorAll('.th-activity-gnode')].map(e => ({ id: e.dataset.node, transform: e.getAttribute('transform'), class: e.getAttribute('class'), opacity: getComputedStyle(e).opacity })),
      partial: document.querySelector('.th-activity-partial')?.textContent ?? null,
      freshness: [...document.querySelectorAll('.th-activity-stale-note,.th-activity-severed-note')].map(e => e.textContent),
      overflow: document.documentElement.scrollWidth > innerWidth };
  });
}
async function settled(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const animations = document.getAnimations().filter(a => a.effect?.target?.closest?.('.th-activity-shelf') && a.effect.getTiming().iterations !== Infinity);
    let timer;
    try { await Promise.race([Promise.all(animations.map(a => a.finished)), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Finite animation deadline')), 8000); })]); }
    finally { clearTimeout(timer); }
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
async function capture(q, name, motion = false) {
  if (!motion) await settled(q.page);
  const data = await state(q.page), path = join(q.out, `${name}.png`);
  await q.page.screenshot({ path, animations: 'allow' });
  q.manifest.push({ name: `${name}.png`, sha256: sha(readFileSync(path)), fixture: q.record.id, url: q.record.url, options: q.record.options, motion, state: data, actionCount: q.record.actions.length, sourceIdentity: q.identityHash });
  return data;
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
  const fixture = startFixture({ port: 0, layout: options.layout ?? 'single', shelves: true });
  const record = { id: receipt.fixtures.length, options, url: fixture.url, navigation: [], actions: [], assets: [], errors: [], cleanup: {}, traffic: fixture.traffic };
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
    await installSignals(page, { theme: options.theme ?? 'dark', lang: options.lang ?? 'en', fontSize: options.fontSize ?? 13 });
    const seeds = seed(), history = options.history ?? seeds.history;
    await page.route('**/chats/*/activity', route => route.fulfill({ json: { history } }));
    // Browser-side readiness is installed before navigation. No wire request that
    // might have happened before a listener is used as an attachment proxy.
    await page.addInitScript(() => {
      window.activityReady = new Promise((done, fail) => {
        const observer = new MutationObserver(check);
        const timer = setTimeout(() => { observer.disconnect(); fail(new Error('Activity hydration deadline')); }, 8000);
        function check() { if (document.querySelector('.th-activity-shelf') && document.querySelector('.th-goal-bar')) { clearTimeout(timer); observer.disconnect(); done(true); } }
        observer.observe(document, { subtree: true, childList: true }); check();
      });
    });
    const q = { page, context, fixture, seeds, record, out: receipt.out, manifest: receipt.manifest, identityHash: receipt.identityHash };
    q.reload = async () => {
      record.navigation.push({ url: fixture.url, at: new Date().toISOString() }); console.log(`navigate ${fixture.url}`);
      await page.goto(fixture.url); await page.evaluate(() => window.activityReady);
      if (!options.noTodo) {
        await arm(page, () => document.querySelector('.th-activity-shelf .th-activity-bar')?.textContent.includes('32'));
        fixture.deliver('stored-a', { type: 'tool', toolCallId: 'r2-todo', toolName: 'todo', phase: 'end', result: { details: { phases: seeds.todo } } });
        await complete(page);
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
      try { await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: null }); record.cleanup.emulationRestored = true; } catch (e) { errors.push(e); }
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
  assert(s.transcript.height >= 119, `120px reserve: ${s.transcript.height}`);
  if (s.activity) assert(s.activity.height <= Number.parseFloat(s.panelMax) + 1);
  if (name.includes('340')) assert(Math.abs(s.pane.width - 340) <= 1, `actual pane width ${s.pane.width}`);
  return s;
}
async function motionArm(q, id, name, interrupt) {
  await q.page.evaluate(({ id, name, interrupt }) => {
    window.motionEvents = [];
    window.motionSignal = new Promise((done, fail) => {
      const timer = setTimeout(() => { cleanup(); fail(new Error(`Motion event deadline ${id}/${name}`)); }, 8000);
      function cleanup() { clearTimeout(timer); document.removeEventListener('animationstart', listener, true); document.removeEventListener('animationcancel', listener, true); document.removeEventListener('animationend', listener, true); }
      function listener(e) {
        if (e.target?.getAttribute?.('data-node') !== id || e.animationName !== name) return;
        window.motionEvents.push({ type: e.type, name, id, at: performance.now(), elapsed: e.elapsedTime });
        if (e.type === 'animationstart') {
          if (interrupt) document.querySelector(interrupt).click();
          else {
            window.motionAnimation = e.target.getAnimations().find(a => a.animationName === name);
            window.motionAnimation.pause(); cleanup(); done(window.motionEvents);
          }
        } else if (interrupt && e.type === 'animationcancel') { cleanup(); done(window.motionEvents); }
      }
      document.addEventListener('animationstart', listener, true); document.addEventListener('animationcancel', listener, true); document.addEventListener('animationend', listener, true);
    });
  }, { id, name, interrupt });
}
function deliverDag(q, run) {
  q.record.actions.push({ action: 'dag-frame', run });
  q.fixture.deliver('stored-a', { type: 'extensionEvent', name: 'omo.dag.updated', data: { parent_session_id: 'qa', truncated_runs: false, runs: [run] } });
}
async function motion(q, interruptions = false) {
  await select(q, 'dag'); await settled(q.page);
  const base = q.seeds.run, data = [];
  if (!interruptions) {
    // Sample actual consecutive compositor frames; time is the behavior under test.
    const running = await q.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
      const a = document.getAnimations().find(a => a.animationName === 'th-dag-run-spin');
      const before = { time: a.currentTime, transform: getComputedStyle(a.effect.target).transform };
      requestAnimationFrame(() => { const during = { time: a.currentTime, transform: getComputedStyle(a.effect.target).transform }; a.pause(); window.runningAnimation = a; resolve({ before, during }); });
    })));
    assert(running.during.time > running.before.time); assert.notEqual(running.during.transform, running.before.transform);
    await capture(q, 'motion-running-during', true); await q.page.evaluate(() => window.runningAnimation.play()); data.push(running);
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
    for (const [switchName, selector] of [['tab', tab('todo')], ['fold', fold], ['list', view('list')]]) for (const terminal of [false, true]) {
      const id = terminal ? 'c' : `new-${switchName}`;
      const running = { ...base, nodes: base.nodes.map(n => n.id === 'c' ? { ...n, state: 'running' } : n), updated_at: new Date().toISOString() };
      await arm(q.page, () => document.querySelector('[data-node="c"]')?.classList.contains('th-activity-gnode--running'));
      deliverDag(q, running); await complete(q.page); await settled(q.page);
      const next = { ...running, nodes: terminal ? running.nodes.map(n => n.id === id ? { ...n, state: 'completed' } : n) : [...running.nodes, { id, label: 'Interrupted entry', prompt: 'Interrupted entry', depends_on: ['b'], state: 'running' }] };
      await capture(q, `interrupt-${switchName}-${terminal}-before`);
      await motionArm(q, id, terminal ? 'th-dag-node-settle' : 'th-dag-node-enter', selector);
      deliverDag(q, next); const events = await q.page.evaluate(() => window.motionSignal);
      const hidden = await capture(q, `interrupt-${switchName}-${terminal}-hidden`, true);
      assert.equal(hidden.animations.filter(a => /th-dag/.test(a.name)).length, 0);
      if (switchName === 'fold') await click(q, fold, () => !!document.querySelector('.th-activity-panel'));
      if (switchName === 'tab') await select(q, 'dag');
      if (switchName === 'list') await changeView(q, 'graph');
      const returned = await state(q.page);
      assert(!returned.animations.some(a => a.node === id && /enter|settle/.test(a.name)), `interrupted motion replay ${switchName}/${terminal}`);
      await capture(q, `interrupt-${switchName}-${terminal}-return`); data.push({ switchName, terminal, events, hidden, returned });
      Object.assign(base, next);
    }
  }
  await select(q, 'todo'); const hidden = await state(q.page);
  assert(hidden.nodes.length > 0); assert.equal(hidden.animations.filter(a => /th-dag/.test(a.name)).length, 0);
  await capture(q, `motion-${interruptions ? 'interrupt' : 'normal'}-mounted-hidden`);
  return { data, hidden };
}

export async function run({ phase = 'green', out, qaPlaywright = DRIVER } = {}) {
  assert(['baseline', 'regression', 'green'].includes(phase)); assert(out);
  out = resolve(out); mkdirSync(out, { recursive: true });
  const receipt = { phase, out, command: `bun test/qa/ui-followup-activity.mjs --phase ${phase} --out ${out}`, startedAt: new Date().toISOString(), identity: await identity(), fixtures: [], scenarios: [], manifest: [] };
  receipt.identityHash = sha(JSON.stringify(receipt.identity));
  writeFileSync(join(out, 'inventory.json'), JSON.stringify({ phase, groups: ['tabs', 'empty-three', 'initial', 'history-freshness', 'scroll', 'resize-reload', 'shared-hooks', 'allocation-4', 'geometry-8', 'motion', 'interruption-6', 'reduced'], command: receipt.command, identity: receipt.identity }, null, 2));
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
      await scenario('interrupted-motion', {}, q => motion(q, true));
      await scenario('shared-hooks', {}, async q => ({ actions: await exerciseShelves(q, name => capture(q, `shared-${name}`)) }));
    } else {
      await scenario('tabs', {}, tabs);
      const s = seed();
      for (const id of ['todo', 'agents', 'dag']) await scenario(`empty-${id}`, { noTodo: true, history: { task: { parent_session_id: 'qa', truncated_tasks: true, tasks: [] }, dag: null } }, async q => { await select(q, id); assert.equal(await q.page.locator(`${panel(id)} .th-activity-empty`).count(), 1); return capture(q, `empty-${id}`); });
      await scenario('initial-agents', { noTodo: true }, async q => { const s = await state(q.page); assert.equal(s.tabs.find(t => t.selected === 'true').id, 'agents'); await select(q, 'agents'); return capture(q, 'initial-agents'); });
      await scenario('history-freshness', { noTodo: true, history: { task: { ...s.history.task, truncated_tasks: true, tasks: s.tasks.map(t => ({ ...t, updated_at: new Date(Date.now() - 600000).toISOString() })) }, dag: { ...s.history.dag, truncated_runs: true, runs: [s.run, { ...s.run, run_id: 'historical', run_key: 'old', name: 'Completed history', status: 'completed' }] } } }, async q => {
        await select(q, 'dag'); assert.equal(await q.page.locator('.th-activity-dag').count(), 2); await capture(q, 'partial-multiple-dags');
        await select(q, 'agents'); const before = await capture(q, 'freshness-before');
        await arm(q.page, () => document.querySelectorAll('.th-activity-stale-note').length === 0);
        q.fixture.deliver('stored-a', { type: 'extensionEvent', name: 'omo.task.updated', data: { ...q.seeds.history.task, tasks: q.seeds.tasks } }); await complete(q.page);
        return { before, after: await capture(q, 'freshness-after') };
      });
      await scenario('scroll', { history: { ...s.history, task: { ...s.history.task, tasks: Array.from({ length: 35 }, (_, i) => ({ ...s.tasks[0], task_id: `task-${i}` })) }, dag: { ...s.history.dag, runs: Array.from({ length: 8 }, (_, i) => ({ ...s.run, run_id: `run-${i}`, run_key: `key-${i}` })) } } }, async q => {
        const data = [];
        for (const id of ['todo', 'agents', 'dag']) { await select(q, id); const owner = q.page.locator(panel(id)); await wheel(q.page, owner, 160, true); const before = await owner.evaluate(e => e.scrollTop); assert(before > 0); await capture(q, `scroll-${id}-before`); await select(q, id === 'todo' ? 'agents' : 'todo'); await select(q, id); const after = await owner.evaluate(e => e.scrollTop); assert.equal(after, before); await capture(q, `scroll-${id}-return`); data.push({ id, before, after }); }
        return data;
      });
      await scenario('resize-reload', {}, resize);
      await scenario('shared-hooks', {}, async q => ({ actions: await exerciseShelves(q, name => capture(q, `shared-${name}`)) }));
      for (const [name, viewport, layout] of [['desktop', { width: 1280, height: 800 }, 'single'], ['mobile', { width: 390, height: 844 }, 'single'], ['340', { width: 685, height: 800 }, 'two'], ['short', { width: 1280, height: 420 }, 'single']]) await scenario(`allocation-${name}`, { viewport, layout }, q => allocation(q, `allocation-${name}`));
      for (const theme of ['dark', 'light']) for (const lang of ['en', 'ko']) for (const fontSize of [13, 24]) {
        const name = `${theme}-${lang}-${fontSize}`;
        await scenario(`geometry-${name}`, { theme, lang, fontSize, viewport: { width: 390, height: 844 } }, async q => {
          await select(q, 'todo'); await capture(q, `${name}-todo`); await select(q, 'agents'); await capture(q, `${name}-agents`); await select(q, 'dag'); await capture(q, `${name}-graph`);
          const nodes = await geometry(q); q.record.geometry = nodes; assertGeometry(nodes);
          assert((await q.page.locator('.th-activity-gedge').evaluateAll(es => es.every(e => e.hasAttribute('marker-end')))));
          const graph = q.page.locator('.th-activity-graph');
          await graph.evaluate(e => { window.qaPending = new Promise((done, fail) => { const timer = setTimeout(() => { e.removeEventListener('scroll', changed); fail(new Error('Horizontal scroll deadline')); }, 8000); function changed() { clearTimeout(timer); e.removeEventListener('scroll', changed); done(e.scrollLeft); } e.addEventListener('scroll', changed); }); });
          const box = await graph.boundingBox(); await q.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await q.page.mouse.wheel(10000, 0); await complete(q.page);
          const reach = await graph.evaluate(e => ({ left: e.scrollLeft, max: e.scrollWidth - e.clientWidth })); assert(Math.abs(reach.left - reach.max) <= 1);
          await capture(q, `${name}-graph-right`); return { nodes, reach };
        });
      }
      await scenario('motion', {}, q => motion(q));
      await scenario('interruption', {}, q => motion(q, true));
      await scenario('reduced', { reduced: true }, async q => { await select(q, 'dag'); const s = await capture(q, 'reduced-motion'); assert.equal(s.animations.length, 0); assert(s.nodes.every(n => n.opacity === '1')); return s; });
    }
  } finally {
    const disconnected = once(browser, 'disconnected'); await browser.close(); await disconnected;
    receipt.cleanup = { browserClosed: !browser.isConnected(), contexts: browser.contexts().length };
    receipt.finishedAt = new Date().toISOString(); receipt.identityAfter = await identity();
    receipt.pendingWorkZero = receipt.fixtures.every(f => f.cleanup.contextClosed && f.cleanup.fixture?.serverStopped && ['pendingWebSockets', 'pendingOpens', 'pendingCreates'].every(k => f.cleanup.fixture[k] === 0) && f.cleanup.errors.length === 0);
    receipt.verdict = receipt.scenarios.every(s => s.ok) && receipt.pendingWorkZero ? 'PASS' : 'FAIL';
    writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(receipt.manifest, null, 2));
  }
  if (receipt.verdict !== 'PASS' && phase !== 'regression') throw new Error(`${phase} failed: ${receipt.scenarios.filter(s => !s.ok).map(s => s.name).join(', ')}`);
  return { verdict: receipt.verdict, scenarios: receipt.scenarios.length, failed: receipt.scenarios.filter(s => !s.ok).map(s => s.name), pngs: receipt.manifest.length, out };
}
if (import.meta.main) {
  try { const args = process.argv.slice(2); console.log(await run({ phase: args[args.indexOf('--phase') + 1], out: args[args.indexOf('--out') + 1], qaPlaywright: process.env.QA_PLAYWRIGHT ?? DRIVER })); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
