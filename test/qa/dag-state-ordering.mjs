/** Actual production App + native Chrome WebSocket QA, isolated in-memory fixture.
 * Node delegates this same entry point to Bun; no build, install, user sessions,
 * application-state hooks, WebSocket replacement, or duplicate DAG reducer.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFixture } from './pane-workspace-ui.mjs';
import { observeSockets } from './heartbeat-liveness.mjs';

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), '../..');
const timeout = 15_000;
export const activityPath = '/api/workspaces/ws/chats/stored-a/activity';
const chat = 'stored-a';
const save = (dir, name, value) => writeFile(join(dir, name), JSON.stringify(value, null, 2) + '\n');

export function parseArgs(args) {
  const options = { scenario: 'all' }, seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--scenario': 'scenario', '--evidence-dir': 'evidenceDir' }[args[i]];
    assert.ok(key && args[i + 1] && !args[i + 1].startsWith('--'), `Invalid argument: ${args[i]}`);
    assert.equal(seen.has(key), false, `Duplicate ${args[i]}`);
    seen.add(key);
    options[key] = args[i + 1];
  }
  assert.ok(['all', 'hydration', 'restart'].includes(options.scenario), 'Unknown scenario');
  assert.ok(options.evidenceDir, '--evidence-dir is required');
  return { ...options, evidenceDir: resolve(options.evidenceDir) };
}

/** Each token belongs to one actual request; no global response/reducer state. */
export function createActivityGate(record = () => {}) {
  const held = new Map(), waiting = new Set(), requests = [];
  let stopped = false;
  function next() {
    assert.equal(stopped, false, 'Activity gate stopped');
    let cancel;
    const promise = new Promise((done, fail) => {
      const waiter = { done(value) { clearTimeout(timer); waiting.delete(waiter); done(value); } };
      const timer = setTimeout(() => { waiting.delete(waiter); fail(new Error('Activity request deadline')); }, timeout);
      cancel = () => { clearTimeout(timer); waiting.delete(waiter); fail(new Error('Activity gate stopped')); };
      waiter.cancel = cancel; waiting.add(waiter);
    });
    promise.catch(() => {});
    return promise;
  }
  async function handle(route) {
    const request = route.request();
    if (request.method() !== 'GET' || new URL(request.url()).pathname !== activityPath) return route.fallback();
    if (stopped) return route.abort();
    const token = requests.length + 1;
    const row = { token, method: request.method(), url: request.url(), state: 'held' };
    requests.push(row);
    // Keep the route handler alive until this exact request is released.
    const pending = new Promise(done => held.set(token, { route, row, done }));
    record({ action: 'activity-held', ...row });
    const waiter = waiting.values().next().value;
    if (waiter) waiter.done(token);
    await pending;
  }
  async function release(token, body) {
    const pending = held.get(token);
    assert.ok(pending && pending.row.state === 'held', `Unknown or released activity token ${token}`);
    pending.row.state = 'releasing';
    try {
      await pending.route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      pending.row.state = 'released'; record({ action: 'activity-released', token, body });
      held.delete(token); pending.done();
    } catch (error) { pending.row.state = 'held'; throw error; }
  }
  async function stop() {
    stopped = true;
    for (const waiter of [...waiting]) waiter.cancel();
    const errors = [];
    for (const [token, pending] of held) {
      try { await pending.route.abort(); pending.row.state = 'aborted'; }
      catch (error) { errors.push({ token, error: String(error) }); pending.row.state = 'abort-failed'; }
      finally { held.delete(token); pending.done(); }
    }
    return { heldRoutes: held.size, pendingWaiters: waiting.size, requests, errors };
  }
  return { next, handle, release, stop, requests };
}

export async function snapshotAssets(source = join(root, 'frontend/dist')) {
  await access(join(source, 'index.html'));
  const directory = await mkdtemp(join(tmpdir(), 'cli-webchat-dag-assets-'));
  try {
    await cp(source, directory, { recursive: true, dereference: true });
    const files = [];
    async function visit(relative = '') {
      for (const entry of (await readdir(join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(relative, entry.name);
        if (entry.isDirectory()) await visit(path);
        else {
          const bytes = await readFile(join(directory, path));
          files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        }
      }
    }
    await visit();
    return { source, directory, files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

/** An exact loopback rebind, not a delayed lsof/poll or an inferred stop flag. */
export function confirmPortReleased(port) {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(error => error ? fail(error) : done(true)));
  });
}

export function launchChild(executable, args, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(executable, args, { stdio: 'inherit', ...options });
    const forward = signal => child.kill(signal);
    const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    const detach = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    child.once('error', error => { detach(); fail(error); });
    child.once('close', (code, signal) => { detach(); done({ pid: child.pid, code, signal, exited: true }); });
  });
}

export function dagRow(status, minute, attempt = 1) {
  return { run_id: 'ordering-run', run_key: 'ordering', name: '작업 순서 검증 DAG - 완료 상태와 새로운 재시도', status,
    created_at: '2026-09-07T10:00:00.000Z', updated_at: `2026-09-07T10:${minute}:00.000Z`,
    counts: { total: 1, pending: 0, blocked: 0, scheduled: 0, running: status === 'running' ? 1 : 0,
      completed: status === 'completed' ? 1 : 0, failed: 0, cancelled: 0, skipped: 0 },
    nodes: [{ id: 'ordering-node', prompt: `작업 결과 검증 및 재시도 ${attempt}`, label: `결과 검증 ${attempt}차 시도`,
      depends_on: [], state: status, attempt }], edges: [], waves: [{ index: 0, node_ids: ['ordering-node'] }] };
}
const completed = () => dagRow('completed', '02');
const stale = () => dagRow('running', '01');
const snapshot = row => ({ parent_session_id: chat, truncated_runs: false, runs: [row] });
const dagFrame = row => ({ type: 'extensionEvent', name: 'omo.dag.updated', data: snapshot(row) });
const historyBody = (row, marker) => ({ history: {
  task: { parent_session_id: chat, truncated_tasks: false, tasks: [{ task_id: marker, name: marker, status: 'completed' }] },
  dag: snapshot(row),
} });
function transcript() {
  return Array.from({ length: 160 }, (_, i) => ({ id: `ordering-entry-${i}`, parentId: i ? `ordering-entry-${i - 1}` : null,
    type: 'message', message: { role: i % 2 ? 'assistant' : 'user',
      content: `ordering-entry-${i}\n\n${'완료된 작업의 결과를 확인하고 새로운 재시도와 이전 기록을 구분합니다. Long saved transcript paragraph. '.repeat(12)}\n\n- 작업 결과 확인\n  - 중첩된 검증 항목\n    - 세 번째 단계\n\n> 저장된 대화 인용\n>\n> - 인용문 안의 검증 기록\n\n\`\`\`js\nconst entry = ${i};\n\`\`\`` } }));
}

export async function installDOMSignals(page) {
  await page.addInitScript(() => {
    localStorage.setItem('th-lang', 'en'); localStorage.setItem('th-theme', 'dark');
    localStorage.setItem('th-ws-expanded', '["ws"]');
    const pending = new Map(); let sequence = 0;
    const scrollEnd = event => { if (event.target.matches?.('.th-chat-body')) window.__dagQA.scrollEnds++; };
    document.addEventListener('scrollend', scrollEnd, true);
    window.__dagQA = {
      scrollEnds: 0,
      arm(source, args) {
        const predicate = (0, eval)(`(${source})`), id = ++sequence;
        let cancel;
        const promise = new Promise((done, fail) => {
          const mo = new MutationObserver(check), ro = new ResizeObserver(check);
          const timer = setTimeout(() => finish(new Error(`DAG DOM deadline: ${source}`)), 15000);
          function finish(error) {
            clearTimeout(timer); mo.disconnect(); ro.disconnect();
            document.removeEventListener('scroll', check, true); document.removeEventListener('scrollend', check, true);
            window.removeEventListener('resize', check);
            error ? fail(error) : done(true);
          }
          function check() { try { if (predicate(args)) finish(); } catch (error) { finish(error); } }
          cancel = () => finish(new Error('DAG DOM signal cancelled'));
          mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
          if (document.documentElement) ro.observe(document.documentElement);
          document.addEventListener('scroll', check, true); document.addEventListener('scrollend', check, true);
          window.addEventListener('resize', check); check();
        });
        promise.catch(() => {}); pending.set(id, { promise, cancel }); return id;
      },
      async done(id) { try { await pending.get(id).promise; } finally { pending.delete(id); } },
      regions() {
        const selectors = { panel: '.th-activity-panel', dag: '.th-activity-dag', head: '.th-activity-dag-head',
          name: '.th-activity-dag-name', status: '.th-activity-dag-head .th-activity-chip', counts: '.th-activity-dag-counts',
          node: '.th-activity-dnode, .th-activity-gnode', nodeLabel: '.th-activity-dnode-label, .th-activity-gnode > text:not(.th-activity-gstatus)',
          nodeStatus: '.th-activity-dnode .th-activity-chip, .th-activity-gstatus',
          composer: '.th-chat-input textarea', transcript: '.th-chat-body' };
        return Object.fromEntries(Object.entries(selectors).map(([key, selector]) => {
          const node = document.querySelector(selector); if (!node) return [key, null];
          const box = node.getBoundingClientRect(), style = getComputedStyle(node);
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          // The open SVG status ring has no fill at its centre; its node owns that hit.
          const owner = node.closest('.th-activity-gnode') ?? node;
          return [key, { ...box.toJSON(), visible: node.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })
            && box.width > 0 && box.height > 0, hit: !!hit && owner.contains(hit),
            color: style.color, background: style.backgroundColor, opacity: style.opacity, font: style.fontFamily,
            fill: style.fill, stroke: style.stroke, clipPath: style.clipPath }];
        }));
      },
      async settle() {
        let timer;
        try {
          return await Promise.race([(async () => {
            const mounted = this.arm(String(() => !!document.querySelector('.th-activity-dag-head')
              && !!document.querySelector('.th-activity-dnode, .th-activity-gnode')));
            await this.done(mounted);
            await document.fonts.ready;
            const animations = document.getAnimations();
            const finite = animations.filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime)
              && !['finished', 'idle'].includes(animation.playState));
            await Promise.all(finite.map(animation => animation.finished));
            const visible = this.arm(String(() => Object.values(window.__dagQA.regions()).every(box => box?.visible && box.hit)));
            await this.done(visible);
            // Cross a paint opportunity after layout/font/animation completion, not a timed delay.
            const frames = [await new Promise(requestAnimationFrame), await new Promise(requestAnimationFrame)];
            const regions = this.regions();
            if (!Object.values(regions).every(box => box?.visible && box.hit)) throw new Error('DAG capture lost visible geometry');
            return { fonts: document.fonts.status, finiteAnimations: finite.length,
              infiniteAnimations: animations.filter(animation => !Number.isFinite(animation.effect.getComputedTiming().endTime)).length,
              frames, scrollEnds: this.scrollEnds, regions };
          })(), new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('DAG capture settlement deadline')), 15000); })]);
        } finally { clearTimeout(timer); }
      },
      stop() {
        document.removeEventListener('scrollend', scrollEnd, true);
        for (const item of pending.values()) item.cancel(); pending.clear(); return pending.size;
      },
    };
    window.__dagQA.initial = window.__dagQA.arm(String(() => !!document.querySelector('.th-chat-input textarea')
      && document.querySelector('.th-chat-body')?.textContent.includes('ordering-entry-159')));
  });
}
const armDOM = (page, predicate, args) => page.evaluate(({ source, args }) => window.__dagQA.arm(source, args), { source: String(predicate), args });
const doneDOM = (page, id) => page.evaluate(id => window.__dagQA.done(id), id);

/** Call from Bun eval with an optional caller-owned browser; only our context is closed.
 * Node callers delegate to the identical Bun entry point and await its exit receipt.
 */
export async function run({ scenario = 'all', evidenceDir, browser: suppliedBrowser, chromium, headless = true } = {}) {
  assert.ok(['all', 'hydration', 'restart'].includes(scenario), 'Unknown scenario');
  assert.ok(evidenceDir, 'evidenceDir is required'); evidenceDir = resolve(evidenceDir);
  await mkdir(evidenceDir, { recursive: true });
  if (!globalThis.Bun) {
    assert.ok(!suppliedBrowser && !chromium, 'Injected browser/driver requires Bun eval');
    assert.equal(headless, true, 'Headed execution requires Bun eval');
    const receipt = await launchChild('/opt/homebrew/bin/bun', [script, '--scenario', scenario, '--evidence-dir', evidenceDir]);
    let cleanup;
    try { cleanup = JSON.parse(await readFile(join(evidenceDir, 'cleanup.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; cleanup = { error: 'Child produced no cleanup receipt' }; }
    cleanup.child = receipt; await save(evidenceDir, 'cleanup.json', cleanup);
    if (receipt.code !== 0) {
      const error = new Error(`Bun QA child exited ${receipt.code ?? receipt.signal}`);
      error.exitCode = receipt.code ?? (receipt.signal === 'SIGINT' ? 130 : 143); throw error;
    }
    const report = JSON.parse(await readFile(join(evidenceDir, 'browser-actions.json'), 'utf8'));
    return { ...report, cleanup };
  }
  const report = { scenario, startedAt: new Date().toISOString(), actions: [], captures: [], errors: [], passed: false };
  const cleanup = { browserOwned: !suppliedBrowser, fixtureInMemoryOnly: true, errors: [] };
  const record = action => report.actions.push({ sequence: report.actions.length + 1, ...action });
  let assets, fixture, browser, context, page, observed, gate, failure;
  let sequence = 0; const prefix = randomUUID();
  const marker = kind => `${kind}-${prefix}-${++sequence}`;
  async function capture(name) {
    const settled = await page.evaluate(() => window.__dagQA.settle());
    const png = await page.screenshot({ path: join(evidenceDir, `${name}.png`), fullPage: false });
    await writeFile(join(evidenceDir, `${name}.html`), await page.content());
    const dom = await page.evaluate(() => {
      const rect = selector => {
        const node = document.querySelector(selector); if (!node) return null;
        const box = node.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { ...box.toJSON(), visible: getComputedStyle(node).visibility === 'visible', hit: !!hit && node.contains(hit) };
      };
      const body = document.querySelector('.th-chat-body');
      return { viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth,
        dag: document.querySelector('.th-activity-dag')?.textContent, panel: rect('.th-activity-panel'),
        composer: rect('.th-chat-input textarea'), transcript: rect('.th-chat-body'),
        scroll: body && { top: body.scrollTop, height: body.scrollHeight, client: body.clientHeight },
        drawerClosed: document.querySelector('.th-sidebar')?.getAttribute('aria-hidden') === 'true'
          && !document.querySelector('.th-backdrop') };
    });
    dom.settled = settled;
    dom.screenshot = { bytes: png.length, sha256: createHash('sha256').update(png).digest('hex'),
      width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    assert.equal(dom.screenshot.width, dom.viewport.width); assert.equal(dom.screenshot.height, dom.viewport.height);
    report.captures.push({ name, ...dom }); await save(evidenceDir, `${name}.json`, dom); return dom;
  }
  async function openShelf() {
    if (await page.locator('.th-activity-bar').getAttribute('aria-expanded') === 'true') return;
    const signal = await armDOM(page, () => document.querySelector('.th-activity-bar')?.getAttribute('aria-expanded') === 'true'
      && document.querySelector('.th-activity-panel')?.getBoundingClientRect().height > 0);
    await page.locator('.th-activity-bar').click(); await doneDOM(page, signal); record({ action: 'open-activity-shelf' });
  }
  async function assertDag(status, attempt = 1) {
    const dag = page.locator('.th-activity-dag');
    assert.equal(await dag.count(), 1);
    const head = dag.locator('.th-activity-dag-head');
    assert.equal(await head.locator('.th-activity-chip').textContent(), status);
    assert.equal(await head.locator('.th-activity-dag-counts').textContent(), `${status === 'completed' ? 1 : 0}/1 done`);
    const expected = dagRow(status, '03', attempt).nodes[0];
    if (await dag.locator('.th-activity-dnode').count()) {
      assert.equal(await dag.locator('.th-activity-dnode .th-activity-chip').textContent(), status);
      assert.equal(await dag.locator('.th-activity-dnode-label').textContent(), expected.label);
    } else {
      assert.equal(await dag.locator('.th-activity-gnode title').textContent(), `${expected.prompt} (${status})`);
    }
    record({ action: 'assert-rendered-dag', status, attempt });
  }
  async function deliverProcessed(frames, label) {
    const sentinel = marker('canonical'), after = observed.mark();
    const delivered = observed.wait(row => row.direction === 'received' && row.frame?.type === 'message'
      && row.frame.message?.content === sentinel, { after, label });
    const signal = await armDOM(page, sentinel => document.querySelector('.th-chat-body')?.textContent.includes(sentinel), sentinel);
    for (const frame of frames) fixture.deliver(chat, frame);
    fixture.deliver(chat, { type: 'message', message: { role: 'assistant', content: sentinel } });
    const received = await delivered; await doneDOM(page, signal);
    const prior = observed.timeline.filter(row => row.sequence > after && row.sequence < received.sequence
      && row.socketId === received.socketId && row.direction === 'received');
    for (const frame of frames) assert.ok(prior.some(row => JSON.stringify(row.frame) === JSON.stringify({ ...frame, sessionId: chat })), 'batch precedes canonical DOM marker on same native socket');
    record({ action: label, frames, sentinel, socketId: received.socketId, processed: true });
  }
  async function hydrate(token, label) {
    const sentinel = marker('rest-task');
    const signal = await armDOM(page, sentinel => [...document.querySelectorAll('.th-activity-agent-name')].some(node => node.textContent === sentinel), sentinel);
    await gate.release(token, historyBody(completed(), sentinel));
    await openShelf(); await doneDOM(page, signal); await assertDag('completed');
    record({ action: label, token, sentinel, hydrationProcessed: true });
  }
  async function reconnect() {
    const after = observed.mark();
    const closed = observed.wait(row => row.kind === 'close', { after, label: 'native disconnect' });
    const created = observed.wait(row => row.direction === 'sent' && row.frame?.type === 'chat.create' && row.frame.chatId === chat, { after, label: 'native reconnect chat.create' });
    const entries = observed.wait(row => row.direction === 'received' && row.frame?.type === 'entries' && row.frame.final, { after, label: 'reconnected final transcript' });
    const refresh = observed.wait(row => row.direction === 'sent' && row.frame?.type === 'activity.refresh', { after, label: 'native reconnect activity.refresh' });
    const pending = gate.next(); fixture.disconnect(chat);
    const [close, create] = await Promise.all([closed, created, entries, refresh]);
    assert.notEqual(close.socketId, create.socketId); const token = await pending;
    record({ action: 'native-reconnect', oldSocket: close.socketId, newSocket: create.socketId, token }); return token;
  }
  async function view(mode) {
    const signal = await armDOM(page, mode => document.querySelector(`.th-activity-view-btn[data-view="${mode}"]`)?.getAttribute('aria-pressed') === 'true'
      && !!document.querySelector(mode === 'graph' ? '.th-activity-gnode' : '.th-activity-dnode'), mode);
    await page.locator(`.th-activity-view-btn[data-view="${mode}"]`).click(); await doneDOM(page, signal);
    record({ action: 'dag-view', mode });
  }
  async function scrollTo(edge) {
    const before = await page.locator('.th-chat-body').evaluate((node, edge) => ({
      height: node.scrollHeight, ends: window.__dagQA.scrollEnds,
      atEdge: edge === 'top' ? node.scrollTop <= 1 : node.scrollHeight - node.clientHeight - node.scrollTop <= 2,
    }), edge);
    if (!before.atEdge) {
      const signal = await armDOM(page, ({ edge, ends }) => {
        const node = document.querySelector('.th-chat-body');
        return window.__dagQA.scrollEnds > ends && !!node
          && (edge === 'top' ? node.scrollTop <= 1 : node.scrollHeight - node.clientHeight - node.scrollTop <= 2);
      }, { edge, ends: before.ends });
      await page.locator('.th-chat-body').hover();
      await page.mouse.wheel(0, edge === 'top' ? -before.height : before.height); await doneDOM(page, signal);
    }
    record({ action: 'transcript-scroll', edge, alreadyAtEdge: before.atEdge,
      scrollEnds: await page.evaluate(() => window.__dagQA.scrollEnds) });
  }
  try {
    assets = await snapshotAssets(); cleanup.assetsDirectory = assets.directory;
    await save(evidenceDir, 'asset-hashes.json', assets);
    fixture = startFixture({ port: 0, assetsDir: assets.directory, controlled: true, layout: 'single', runs: { [chat]: { entries: transcript() } } });
    cleanup.fixtureURL = fixture.url;
    const driver = chromium ?? (suppliedBrowser ? null : (await import(pathToFileURL(process.env.QA_PLAYWRIGHT ?? '/private/tmp/omo-asar/node_modules/playwright-core/index.mjs').href)).chromium);
    browser = suppliedBrowser ?? await driver.launch({ executablePath: process.env.QA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless, timeout });
    report.browserVersion = browser.version();
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    context.setDefaultTimeout(timeout); page = await context.newPage(); observed = observeSockets(page);
    page.on('pageerror', error => report.errors.push({ kind: 'pageerror', message: String(error) }));
    page.on('console', message => { if (message.type() === 'error') report.errors.push({ kind: 'console', message: message.text() }); });
    page.on('response', response => { if (response.status() >= 400) report.errors.push({ kind: 'http', url: response.url(), status: response.status() }); });
    gate = createActivityGate(record); await page.route(new RegExp(`${activityPath}(?:\\?.*)?$`), gate.handle);
    await installDOMSignals(page);
    const pending = gate.next();
    const entries = observed.wait(row => row.direction === 'received' && row.frame?.type === 'entries' && row.frame.final, { label: 'initial final transcript' });
    await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
    assert.equal((await entries).frame.entries.length, 160); const token = await pending;
    await page.evaluate(() => window.__dagQA.done(window.__dagQA.initial));
    if (scenario !== 'restart') {
      assert.equal(await page.locator('.th-activity-dag').count(), 0, 'empty initial DAG');
      await deliverProcessed([dagFrame(stale())], 'C2-empty-stale-while-REST-held');
      await openShelf(); await assertDag('running');
      await hydrate(token, 'C2-empty-REST-completed'); await capture('browser-c2-empty');
      await deliverProcessed([dagFrame(stale())], 'C1-stale-after-completed');
      await assertDag('completed'); await capture('browser-c1');
      const retained = await reconnect(); await assertDag('completed');
      await deliverProcessed([dagFrame(stale())], 'C2-retained-stale-while-REST-held');
      await assertDag('completed'); await hydrate(retained, 'C2-retained-REST-completed');
      await capture('browser-c2-retained');
    } else await hydrate(token, 'restart-baseline');
    if (scenario !== 'hydration') {
      await deliverProcessed([{ type: 'run.started' }], 'C3-parent-start'); await assertDag('completed');
      await deliverProcessed([{ type: 'run.done', reason: 'stop' }], 'C3-parent-done'); await assertDag('completed');
      await capture('browser-c3-parent');
      await deliverProcessed([dagFrame(dagRow('running', '03', 2))], 'C3-newer-retry'); await assertDag('running', 2);
      await capture('browser-c3-restart');
      for (const mode of ['list', 'graph']) {
        await view(mode); await assertDag('running', 2);
        for (const edge of ['top', 'bottom']) {
          await scrollTo(edge); const dom = await capture(`browser-desktop-${mode}-${edge}`);
          assert.ok(dom.scroll.height > dom.scroll.client, 'long transcript really overflows');
          for (const box of [dom.composer, dom.panel, dom.transcript]) assert.ok(box?.visible && box.width > 0 && box.height > 0
            && box.x >= 0 && box.y >= 0 && box.right <= 1281 && box.bottom <= 801, 'bounded visible transcript, shelf and composer');
          assert.ok(dom.composer.hit, 'composer is unobscured');
        }
      }
      const collapsed = await armDOM(page, () => !!document.querySelector('.th-sidebar--collapsed'));
      await page.locator('.th-sidebar-nav .th-sidebar-toggle').click(); await doneDOM(page, collapsed);
      // Crossing the split breakpoint mounts ChatPane in place of SplitView.
      // Observe that real new attachment and hydrate its own request, not the
      // desktop hook's old state or a guessed duplicate response slot.
      const mobileRequest = gate.next(), mobileAfter = observed.mark();
      const mobileEntries = observed.wait(row => row.direction === 'received' && row.frame?.type === 'entries'
        && row.frame.sessionId === chat && row.frame.final, { after: mobileAfter, label: 'mobile reattachment transcript' });
      const mobile = await armDOM(page, () => innerWidth === 390 && innerHeight === 844
        && document.querySelector('.th-sidebar')?.getAttribute('aria-hidden') === 'true');
      await page.setViewportSize({ width: 390, height: 844 }); await doneDOM(page, mobile);
      await mobileEntries; await hydrate(await mobileRequest, 'C3-mobile-REST-baseline');
      await deliverProcessed([dagFrame(dagRow('running', '03', 2))], 'C3-mobile-newer-retry');
      for (const mode of ['list', 'graph']) {
        await view(mode); await assertDag('running', 2); const dom = await capture(`browser-mobile-${mode}`);
        assert.ok(dom.drawerClosed && dom.documentWidth <= 390, 'mobile drawer closed; no document overflow');
        assert.ok(dom.composer.hit && dom.composer.bottom <= 845, 'mobile composer remains usable');
      }
      await capture('browser-mobile');
    }
    assert.equal(fixture.frames.filter(frame => frame.type === 'chat.send').length, 0, 'QA/reconnect never sends a prompt');
    assert.deepEqual(fixture.unexpected, []); assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    failure = error; report.error = { message: error.message, stack: error.stack };
    report.errors.push({ kind: 'runner', ...report.error });
  }
  finally {
    const clean = async (name, action) => {
      try { cleanup[name] = await action() ?? true; }
      catch (error) { cleanup[name] = false; cleanup.errors.push({ name, error: String(error) }); }
    };
    if (page && !page.isClosed()) await clean('finalCapture', () => capture(failure ? 'browser-failure' : 'browser-final'));
    if (gate) await clean('routes', async () => { const receipt = await gate.stop(); assert.deepEqual(receipt.errors, []); return receipt; });
    if (page && !page.isClosed()) await clean('domObservers', () => page.evaluate(() => window.__dagQA?.stop() ?? 0));
    if (observed) { observed.stop(); cleanup.socketObserverStopped = true; }
    if (context) await clean('contextClosed', () => context.close());
    if (browser && !suppliedBrowser) await clean('browserClosed', async () => { await browser.close(); assert.equal(browser.isConnected(), false); return true; });
    if (suppliedBrowser) cleanup.callerBrowserRetained = true;
    if (fixture) {
      await clean('fixture', () => fixture.stop());
      await clean('portReleased', () => confirmPortReleased(Number(new URL(fixture.url).port)));
    }
    if (assets) await clean('assetsRemoved', async () => {
      await rm(assets.directory, { recursive: true, force: true });
      await assert.rejects(access(assets.directory), { code: 'ENOENT' }); return true;
    });
    report.passed = report.passed && !failure && cleanup.errors.length === 0;
    report.finishedAt = new Date().toISOString();
    await save(evidenceDir, 'websocket-timeline.json', observed?.timeline ?? []);
    await save(evidenceDir, 'fixture-traffic.json', fixture?.traffic ?? []);
    await save(evidenceDir, 'browser-errors.json', report.errors);
    await save(evidenceDir, 'cleanup.json', cleanup);
    await save(evidenceDir, 'browser-actions.json', report);
  }
  if (failure) throw failure;
  assert.deepEqual(cleanup.errors, [], 'QA cleanup failed');
  return { ...report, cleanup };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await run(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({ passed: result.passed, scenario: result.scenario, cleanup: result.cleanup }, null, 2));
  } catch (error) { console.error(error.stack); process.exitCode = error.exitCode ?? 1; }
}
