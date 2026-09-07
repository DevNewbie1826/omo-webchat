/** Actual embedded App + api.Server + Go WebSocket bridge + isolated RPC provider.
 * Build the candidate fixture separately on stable source; this runner never
 * installs, builds, touches user sessions, or authors chat.todo server frames.
 * Node: node test/qa/todo-state-ordering.mjs --fixture-bin /absolute/todofixture --evidence-dir /absolute/evidence
 * Bun eval: await run({ fixtureBin, evidenceDir, browser }); caller browser retained.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { observeSockets } from './heartbeat-liveness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const deadline = 20_000;
const chatId = 'todo-qa-chat';
const durableSessionId = 'todo-qa-durable';
const wsId = 'todo-qa-workspace';
const save = (dir, name, value) => writeFile(join(dir, name), JSON.stringify(value, null, 2) + '\n');
export const phase = (content, status = 'pending') => [{ name: '검증', tasks: [{ content, status }] }];
export const custom = phases => ({ type: 'custom', customType: 'senpi.todo-state', data: { schema: 'v2', phases } });
export const completion = phases => ({ phases, completedTasks: [{ phase: '검증', content: '완료 항목' }] });
export const legacy = phases => ({ type: 'message', message: { role: 'toolResult', toolName: 'todo', toolCallId: 'delayed-result-A',
  content: [{ type: 'text', text: JSON.stringify(completion(phases)) }], details: completion(phases), isError: false } });

export function parseArgs(args) {
  const options = {}, seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--evidence-dir': 'evidenceDir', '--fixture-bin': 'fixtureBin' }[args[i]];
    assert.ok(key && args[i + 1] && !args[i + 1].startsWith('--'), `Invalid argument ${args[i]}`);
    assert.ok(!seen.has(key), `Duplicate ${args[i]}`); seen.add(key); options[key] = resolve(args[i + 1]);
  }
  assert.ok(options.evidenceDir && options.fixtureBin, '--evidence-dir and --fixture-bin are required');
  return options;
}

/** Check provenance without inventing a revision from opaque branch positions. */
export function assertProjection(frame, binding, phases) {
  assert.equal(typeof binding, 'string'); assert.ok(binding.length > 0);
  assert.equal(frame.type, 'chat.todo'); assert.equal(frame.sessionId, chatId);
  assert.equal(frame.durableSessionId, durableSessionId); assert.equal(frame.bindingId, binding);
  assert.equal(frame.status, 'ready'); assert.ok(Number.isSafeInteger(frame.requestGeneration) && frame.requestGeneration >= 0);
  assert.ok(['custom', 'legacy-tool', 'absent'].includes(frame.source?.kind));
  assert.ok(frame.source.leafId === null || typeof frame.source.leafId === 'string');
  if (frame.source.kind === 'absent') {
    assert.equal(frame.source.entryId, null); assert.equal(frame.source.entryIndex, null); assert.equal(frame.phases, null);
  } else {
    assert.equal(typeof frame.source.entryId, 'string');
    assert.ok(Number.isSafeInteger(frame.source.entryIndex) && frame.source.entryIndex >= 0);
  }
  assert.deepEqual(frame.phases, phases);
}

/** A later native-socket frame plus its new DOM marker fences synchronous App
 * handling of the earlier frame; unchanged retained todo text is not a signal. */
export async function applicationBarrier(observed, { after, marker }, { arm, publish, done }) {
  const token = await arm(marker);
  const pending = observed.wait(row => row.socketId === after.socketId && row.direction === 'received'
    && row.frame?.type === 'tool' && row.frame.sessionId === after.frame.sessionId
    && row.frame.toolCallId === marker && row.frame.phase === 'end',
  { after: after.sequence, timeout: deadline, label: `application marker ${marker}` });
  try {
    await publish(marker);
    const row = await pending;
    await done(token);
    return row;
  } finally { pending.cancel(); }
}

export async function bounded(promise, label, timeout = deadline) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Deadline: ${label}`)), timeout); })]); }
  finally { clearTimeout(timer); }
}

export async function startOwnedFixture(fixtureBin, evidenceDir) {
  await access(fixtureBin);
  const child = spawn(fixtureBin, [], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [], errors = [];
  child.stderr.on('data', data => errors.push(String(data)));
  const exited = new Promise((done, fail) => { child.once('error', fail); child.once('close', (code, signal) => done({ pid: child.pid, code, signal })); });
  exited.catch(() => {});
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise((done, fail) => {
    lines.on('line', line => {
      output.push(line);
      try { const value = JSON.parse(line); if (value.type === 'todo-fixture-ready') done(value); }
      catch (error) { fail(new Error(`Invalid fixture readiness JSON: ${error.message}`)); }
    });
    exited.then(receipt => fail(new Error(`Fixture exited before ready: ${JSON.stringify(receipt)}`)), fail);
  });
  let info;
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let receipt;
    try { receipt = await bounded(exited, 'fixture exit'); }
    catch (error) { child.kill('SIGKILL'); await bounded(exited, 'forced fixture exit'); throw error; }
    finally { lines.close(); await writeFile(join(evidenceDir, 'fixture-stdout.log'), output.join('\n') + '\n'); await writeFile(join(evidenceDir, 'fixture-stderr.log'), errors.join('')); }
    assert.equal(receipt.code, 0, 'fixture teardown exit');
    if (info) {
      await assert.rejects(access(info.root), { code: 'ENOENT' });
      for (const url of [info.url, info.controlURL]) await portReleased(Number(new URL(url).port));
    }
    return { ...receipt, rootRemoved: !!info, portsReleased: !!info };
  }
  try { info = await bounded(ready, 'fixture readiness'); return { ...info, stop }; }
  catch (error) { try { await stop(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'fixture start and cleanup failed'); } throw error; }
}
function portReleased(port) {
  return new Promise((done, fail) => { const server = createServer(); server.once('error', fail);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(error => error ? fail(error) : done(true))); });
}

export async function installDOMSignals(page) {
  await page.addInitScript(({ wsId }) => {
    localStorage.setItem('th-lang', 'en'); localStorage.setItem('th-theme', 'dark');
    localStorage.setItem('th-ws-expanded', JSON.stringify([wsId]));
    const pending = new Map(); let next = 0;
    window.__todoQA = {
      read() {
        return [...document.querySelectorAll('[data-activity-tabpanel="todo"] .th-activity-phase')].map(node => ({
          name: node.querySelector('.th-activity-phase-name').textContent,
          tasks: [...node.querySelectorAll('.th-activity-todo-task')].map(task => ({
            content: task.querySelector('.th-activity-todo-text').textContent,
            status: [...task.classList].find(name => name.startsWith('th-activity-todo-task--')).slice('th-activity-todo-task--'.length),
          })),
        }));
      },
      arm(source, args) {
        const predicate = (0, eval)(`(${source})`), id = ++next;
        let cancel;
        const promise = new Promise((done, fail) => {
          let finished = false;
          const mo = new MutationObserver(check), ro = new ResizeObserver(check);
          const timer = setTimeout(() => finish(new Error(`Todo DOM deadline: ${source}`)), 20000);
          function finish(error) { if (finished) return; finished = true; clearTimeout(timer); mo.disconnect(); ro.disconnect();
            window.removeEventListener('resize', check); error ? fail(error) : done(true); }
          function check() { try { if (predicate(args)) finish(); } catch (error) { finish(error); } }
          cancel = () => finish(new Error('Todo DOM observer stopped'));
          mo.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
          if (document.documentElement) ro.observe(document.documentElement); window.addEventListener('resize', check); check();
        });
        promise.catch(() => {}); pending.set(id, { promise, cancel }); return id;
      },
      async done(id) { const signal = pending.get(id); if (!signal) throw new Error(`Unknown DOM token ${id}`);
        try { return await signal.promise; } finally { pending.delete(id); } },
      stop() { for (const value of pending.values()) value.cancel(); pending.clear(); return 0; },
    };
  }, { wsId });
}
const arm = (page, predicate, args) => page.evaluate(({ source, args }) => window.__todoQA.arm(source, args), { source: String(predicate), args });
const done = (page, token) => page.evaluate(token => window.__todoQA.done(token), token);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function run({ fixtureBin, evidenceDir, browser: suppliedBrowser, chromium, headless = true } = {}) {
  assert.ok(fixtureBin && evidenceDir, 'fixtureBin and evidenceDir required');
  evidenceDir = resolve(evidenceDir); await mkdir(evidenceDir, { recursive: true });
  const report = { passed: false, actions: [], captures: [], errors: [], startedAt: new Date().toISOString() };
  const cleanup = { errors: [], browserOwned: !suppliedBrowser };
  let fixture, browser, context, page, observed, failure, binding, current, generation = -1;
  const record = action => report.actions.push({ sequence: report.actions.length + 1, ...action });
  async function control(path, body = {}) {
    const response = await fetch(fixture.controlURL + path, { method: path === '/state' ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' }, ...(path === '/state' ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(deadline) });
    const raw = await response.text(); assert.equal(response.status, 200, `${path}: ${raw}`);
    const value = JSON.parse(raw); record({ control: path, request: body, response: value }); return value;
  }
  const received = (row, type) => row.direction === 'received' && row.frame?.type === type && row.frame.sessionId === chatId;
  function nextProjection(phases, after = observed.mark(), status = 'ready') {
    return observed.wait(row => received(row, 'chat.todo') && row.frame.status === status
      && (status !== 'ready' || same(row.frame.phases, phases)), { after, timeout: deadline, label: `canonical todo ${status}` });
  }
  async function consume(row, expected, { rebind = false } = {}) {
    if (rebind) {
      const ready = observed.timeline.findLast(item => item.sequence < row.sequence && item.socketId === row.socketId && received(item, 'ready'));
      assert.ok(ready?.frame.bindingId, 'ready announces canonical binding'); assert.equal(ready.frame.piSessionId, durableSessionId); binding = ready.frame.bindingId; generation = -1;
    }
    assertProjection(row.frame, binding, expected);
    assert.ok(row.frame.requestGeneration >= generation, 'acquisitions do not regress within binding'); generation = row.frame.requestGeneration;
    current = row.frame;
    record({ action: 'canonical-published', socketId: row.socketId, frame: row.frame });
  }
  async function shelf() {
    if (await page.locator('.th-activity-fold').getAttribute('aria-expanded') !== 'true') {
      const token = await arm(page, () => document.querySelector('.th-activity-fold')?.getAttribute('aria-expanded') === 'true');
      await page.locator('.th-activity-fold').click(); await done(page, token);
    }
    if (await page.locator('[data-activity-tab="todo"]').getAttribute('aria-selected') !== 'true') {
      const token = await arm(page, () => document.querySelector('[data-activity-tab="todo"]')?.getAttribute('aria-selected') === 'true');
      await page.locator('[data-activity-tab="todo"]').click(); await done(page, token);
    }
  }
  async function rendered(expected) {
    const token = await arm(page, expected => JSON.stringify(window.__todoQA.read()) === JSON.stringify(expected), expected);
    await done(page, token); assert.deepEqual(await page.evaluate(() => window.__todoQA.read()), expected);
    record({ action: 'rendered-whole-list', phases: expected });
  }
  async function append(entry, expected, label, extra = {}) {
    const after = observed.mark(), pending = nextProjection(expected, after);
    const token = await arm(page, expected => JSON.stringify(window.__todoQA.read()) === JSON.stringify(expected), expected);
    const result = await control('/append', { entry, persist: true, ...extra });
    const row = await pending; await consume(row, expected);
    assert.equal(row.frame.source.leafId, result.entryId, 'projection includes exact committed source boundary');
    await done(page, token); await rendered(expected); record({ action: label, entryId: result.entryId }); return result.entryId;
  }
  async function paint() {
    await bounded(page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect.getComputedTiming().endTime) && !['finished', 'idle'].includes(a.playState)).map(a => a.finished));
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    }), 'font/animation/paint settlement');
  }
  async function capture(name, proof) {
    await paint();
    const dom = await page.evaluate(() => {
      const rect = selector => { const node = document.querySelector(selector); if (!node) return null; const box = node.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { ...box.toJSON(), visible: node.checkVisibility(), hit: !!hit && node.contains(hit) }; };
      const transcript = document.querySelector('.th-chat-body');
      return { viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth,
        phases: window.__todoQA.read(), composer: rect('.th-chat-input textarea'), panel: rect('[data-activity-tabpanel="todo"]'),
        transcript: rect('.th-chat-body'), scroll: transcript && { height: transcript.scrollHeight, client: transcript.clientHeight },
        drawerClosed: document.querySelector('.th-sidebar')?.getAttribute('aria-hidden') === 'true' && !document.querySelector('.th-backdrop') };
    });
    const png = await page.screenshot({ path: join(evidenceDir, name + '.png'), fullPage: false });
    assert.equal(png.readUInt32BE(16), dom.viewport.width); assert.equal(png.readUInt32BE(20), dom.viewport.height);
    assert.ok(dom.scroll.height > dom.scroll.client, 'long transcript actually overflows');
    for (const box of [dom.panel, dom.composer, dom.transcript]) assert.ok(box?.visible && box.width > 0 && box.height > 0
      && box.x >= 0 && box.y >= 0 && box.right <= dom.viewport.width + 1 && box.bottom <= dom.viewport.height + 1, 'bounded visible application regions');
    assert.ok(dom.composer.hit, 'composer remains usable'); assert.ok(dom.documentWidth <= dom.viewport.width, 'no horizontal document overflow');
    if (dom.viewport.width === 390) assert.ok(dom.drawerClosed, 'mobile drawer closed');
    const receipt = { name, ...dom, ...(proof ? { proof } : {}), screenshot: { bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') } };
    report.captures.push(receipt); await save(evidenceDir, name + '.json', receipt); await writeFile(join(evidenceDir, name + '.html'), await page.content());
  }
  async function captureUnavailable(name, row, expected, detail = {}) {
    assert.equal(row.frame.type, 'chat.todo'); assert.equal(row.frame.status, 'unavailable');
    assert.equal(row.frame.sessionId, chatId); assert.equal(row.frame.durableSessionId, durableSessionId);
    assert.equal(row.frame.bindingId, binding); assert.equal(row.frame.error, 'history-unavailable');
    assert.ok(Number.isSafeInteger(row.frame.requestGeneration) && row.frame.requestGeneration >= generation);
    assert.equal(row.frame.source, undefined); assert.equal(row.frame.phases, undefined);
    const ready = observed.timeline.findLast(item => item.sequence < row.sequence && item.socketId === row.socketId && received(item, 'ready'));
    assert.equal(ready?.frame.bindingId, binding); assert.equal(ready.frame.piSessionId, durableSessionId);
    assert.deepEqual(current.phases, expected);
    const marker = `qa-barrier-${name}`;
    assert.equal(await page.locator(`[data-tool-call-id="${marker}"]`).count(), 0, 'render marker is new');
    const markerRow = await applicationBarrier(observed, { after: row, marker }, {
      arm: marker => arm(page, marker => !!document.querySelector(`[data-tool-call-id="${marker}"].th-tool--ok`), marker),
      publish: marker => control('/events', { events: [{ type: 'tool_execution_end', toolCallId: marker, toolName: 'read',
        result: { content: [{ type: 'text', text: marker }] }, isError: false }] }),
      done: token => done(page, token),
    });
    await rendered(expected);
    const proof = { unavailable: row, ready, retained: current, marker: markerRow, ...detail };
    await capture(name, proof);
    assert.equal(observed.timeline.filter(item => item.sequence > row.sequence && item.socketId === row.socketId
      && (received(item, 'ready') || (received(item, 'chat.todo') && item.frame.status === 'ready'))).length, 0,
    'capture precedes any recovery or replacement binding');
    record({ action: 'unavailable-retained-capture', name, proof });
  }
  async function reload(expected) {
    const after = observed.mark(), pending = nextProjection(expected, after);
    await page.reload({ waitUntil: 'domcontentloaded' }); await consume(await pending, expected, { rebind: true }); await shelf(); await rendered(expected);
  }
  try {
    fixture = await startOwnedFixture(resolve(fixtureBin), evidenceDir);
    report.fixture = fixture; // stop() is omitted by JSON serialization.
    report.binary = { path: resolve(fixtureBin), sha256: createHash('sha256').update(await readFile(fixtureBin)).digest('hex') };
    const driver = chromium ?? (suppliedBrowser ? null : (await import(pathToFileURL(process.env.QA_PLAYWRIGHT ?? '/private/tmp/omo-asar/node_modules/playwright-core/index.mjs').href)).chromium);
    browser = suppliedBrowser ?? await driver.launch({ executablePath: process.env.QA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless, timeout: deadline });
    report.browserVersion = browser.version();
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' }); context.setDefaultTimeout(deadline);
    const login = await context.request.post(fixture.url + '/api/login', { data: { password: 'todo-qa-password' } }); assert.equal(login.status(), 200);
    page = await context.newPage(); observed = observeSockets(page); await installDOMSignals(page);
    page.on('pageerror', error => report.errors.push({ kind: 'pageerror', message: String(error) }));
    page.on('console', message => { if (message.type() === 'error') report.errors.push({ kind: 'console', message: message.text() }); });
    const A = phase('복원 항목 A'), B = phase('중첩 갱신 B', 'in_progress'), C = phase('완료 항목', 'completed');
    const initial = nextProjection(A, 0);
    const transcript = observed.wait(row => received(row, 'entries') && row.frame.final, { after: 0, timeout: deadline, label: 'restored transcript terminal' });
    await page.goto(fixture.url, { waitUntil: 'domcontentloaded' }); await transcript; await consume(await initial, A, { rebind: true });
    await shelf(); await rendered(A); await capture('desktop-restored-A');
    const customOnlyStart = observed.mark();
    await append(custom(B), B, 'restore-A-to-custom-only-B');
    assert.equal(observed.timeline.filter(row => row.sequence > customOnlyStart && received(row, 'tool') && row.frame.toolName === 'todo').length, 0,
      'custom-only mutation reaches App without any direct todo tool frame');
    await capture('desktop-custom-only-B');
    const toolAfter = observed.mark();
    const tool = observed.wait(row => received(row, 'tool') && row.frame.toolCallId === 'completion-array' && row.frame.phase === 'end', { after: toolAfter, label: 'actual-shaped completion result' });
    await control('/events', { events: [
      { type: 'tool_execution_start', toolCallId: 'completion-array', toolName: 'todo', args: { action: 'complete' } },
      { type: 'tool_execution_end', toolCallId: 'completion-array', toolName: 'todo', result: { content: [{ type: 'text', text: JSON.stringify(completion(C)) }], details: completion(C) }, isError: false },
    ] });
    const toolRow = await tool; assert.deepEqual(toolRow.frame.result.details.completedTasks, completion(C).completedTasks);
    await paint(); await rendered(B); // Live result alone does not commit.
    await append(custom(C), C, 'canonical-completion-array'); await capture('desktop-completed');
    await append(custom(phase('완료 항목', 'in_progress')), phase('완료 항목', 'in_progress'), 'intentional-reopen');
    await append(custom(phase('초기화한 새 항목')), phase('초기화한 새 항목'), 'init-whole-list');
    for (const [label, phases] of [
      ['append', [{ name: '검증', tasks: [{ content: 'first', status: 'pending' }, { content: 'second', status: 'pending' }] }]],
      ['drop-task', phase('second')], ['re-add-task', [{ name: '검증', tasks: [{ content: 'first', status: 'pending' }, { content: 'second', status: 'pending' }] }]],
      ['rename', phase('renamed', 'abandoned')], ['remove-phase', [{ name: 'remaining', tasks: [] }]],
    ]) await append(custom(phases), phases, `whole-list-${label}`);
    await append(custom(B), B, 'custom-B-before-delayed-A');
    await append(legacy(A), B, 'delayed-persisted-result-A-cannot-override-B');
    const delayed = observed.wait(row => received(row, 'tool') && row.frame.toolCallId === 'delayed-result-A', { after: observed.mark(), label: 'delayed live A' });
    await control('/events', { events: [{ type: 'tool_execution_end', toolCallId: 'delayed-result-A', toolName: 'todo', result: { details: completion(A) } }] });
    await delayed; await paint(); await rendered(B);
    await append(custom([{}]), B, 'malformed-preserves-incumbent');
    await append(custom([{ name: 'valid', tasks: [] }, { name: 'invalid', tasks: [{}] }]), B, 'malformed-task-is-atomic');
    const parentDone = observed.wait(row => received(row, 'run.done'), { after: observed.mark(), label: 'parent run terminal' });
    await control('/events', { events: [{ type: 'agent_start' }, { type: 'agent_end', willRetry: false }, { type: 'agent_settled', reason: 'end_turn' }] });
    await parentDone; await paint(); await rendered(B); record({ action: 'parent-run-preserves-todo' });
    await append(custom([]), [], 'explicit-clear'); await capture('desktop-clear');
    await append({ type: 'compaction', summary: 'Synthetic compaction backup', firstKeptEntryId: 'todo-entry-0001', tokensBefore: 1000,
      details: { todo: { capturedAt: '2099-01-01T00:00:00Z', phases: A } } }, [], 'compaction-backup-cannot-revive-clear');
    await control('/events', { events: [{ type: 'compaction_start' }, { type: 'compaction_end' }] });
    await append(custom([{ name: '비어 있는 단계', tasks: [] }]), [{ name: '비어 있는 단계', tasks: [] }], 'named-empty-clear');
    await append(custom(A), A, 'branch-anchor-setup');
    const branchAnchor = current.source.leafId;
    await append(custom(B), B, 'abandoned-branch-B');
    await append(custom([]), [], 'selected-branch-clear', { parent: branchAnchor });
    await reload([]); await rendered([]); // History restoration cannot revive B.
    await append(custom(B), B, 'before-read-failure');
    const unavailable = nextProjection(null, observed.mark(), 'unavailable');
    await control('/read/failure', { enabled: true });
    await control('/append', { entry: custom(A), persist: true });
    const failedRead = await unavailable; assert.equal(failedRead.frame.bindingId, binding); await paint(); await rendered(B);
    await captureUnavailable('desktop-provider-unavailable', failedRead, B);
    const recovered = nextProjection(A, observed.mark()); await control('/read/failure', { enabled: false });
    await control('/append', { entry: custom(A), persist: true }); await consume(await recovered, A); await rendered(A);
    // Capture A behind a real provider read gate, then replace the binding and
    // canonical source. Only this one read is held, so replacement can proceed.
    const gate = await control('/read/arm');
    const entered = control('/read/await', { token: gate.token });
    await control('/append', { entry: custom(A), persist: true });
    const held = await entered; assert.ok(held.snapshot.data.leafId);
    await control('/append', { entry: custom(B), persist: true });
    const oldBinding = binding; await reload(B); assert.notEqual(binding, oldBinding);
    await control('/read/release', { token: gate.token });
    await append(custom(B), B, 'old-blocked-read-cannot-publish-after-reconnect');
    assert.equal(observed.timeline.filter(row => received(row, 'chat.todo') && row.frame.bindingId === oldBinding
      && row.frame.source?.leafId === held.snapshot.data.leafId).length, 0, 'held old acquisition never published');
    // Concrete provider epoch recovery, not merely a new frontend fixture.
    await control('/drop-provider'); await reload(B); await rendered(B); record({ action: 'provider-epoch-recovery' });
    // Manual rebind keeps the mounted App and its whole-list incumbent. Hold a
    // failed provider acquisition until after the unavailable pixels are saved.
    const retainedBinding = binding;
    await control('/read/failure', { enabled: true });
    const rebindStart = observed.mark(), rebound = observed.wait(row => received(row, 'ready') && row.frame.bindingId !== retainedBinding,
      { after: rebindStart, timeout: deadline, label: 'manual rebind ready' });
    const rebindUnavailable = observed.wait(row => received(row, 'chat.todo') && row.frame.status === 'unavailable'
      && row.frame.bindingId !== retainedBinding,
    { after: rebindStart, timeout: deadline, label: 'replacement binding unavailable' });
    await page.locator('.th-chat-resync-btn').click();
    const reboundReady = await rebound;
    binding = reboundReady.frame.bindingId; generation = -1; assert.notEqual(binding, retainedBinding);
    const reboundFailure = await rebindUnavailable;
    const recoveryGate = await control('/read/arm');
    const recoveryEntered = control('/read/await', { token: recoveryGate.token });
    const recoverySource = await control('/append', { entry: custom(A), persist: true });
    const recoveryHeld = await recoveryEntered;
    assert.equal(recoveryHeld.snapshot.success, false); assert.equal(recoveryHeld.snapshot.error, 'QA_READ_FAILURE');
    await shelf();
    await captureUnavailable('desktop-rebinding-unavailable', reboundFailure, B,
      { retainedBinding, gate: recoveryGate, held: recoveryHeld, recoverySource });
    await control('/read/release', { token: recoveryGate.token });
    const rebindRecovered = nextProjection(A, observed.mark());
    await control('/read/failure', { enabled: false });
    await control('/append', { entry: custom(A), persist: true });
    await consume(await rebindRecovered, A); await rendered(A);
    record({ action: 'blocked-rebind-recovered', retainedBinding, frame: current });
    await append(custom(B), B, 'restore-B-after-rebind-proof');
    // Disk descriptor failure while resident allows a real provider marker to
    // reach the App. The original idle/no-wake failure scenario remains below.
    const residentDiskFailure = nextProjection(null, observed.mark(), 'unavailable');
    await control('/disk/failure', { enabled: true });
    await captureUnavailable('desktop-disk-unavailable', await residentDiskFailure, B);
    const residentDiskRecovery = nextProjection(B, observed.mark());
    await control('/disk/failure', { enabled: false });
    await consume(await residentDiskRecovery, B); await rendered(B);
    // A live-only source must not roll back to older disk after provider eviction.
    const liveC = nextProjection(C, observed.mark());
    await control('/append', { entry: custom(C), persist: false });
    await control('/events', { events: [{ type: 'tool_execution_end', toolCallId: 'nested-eval', toolName: 'eval', result: { content: [] } }] });
    await consume(await liveC, C); await rendered(C);
    const beforeEvict = (await control('/state')).openCount;
    const evicted = nextProjection(null, observed.mark(), 'unavailable');
    await control('/evict');
    // Unchanged idle ticks only check metadata. Exercise the App's existing
    // visible-tab refresh to acquire the disk-lag result without reopening.
    const refresh = observed.wait(row => row.direction === 'sent' && row.frame?.type === 'activity.refresh'
      && row.frame.sessionId === chatId, { after: observed.mark(), label: 'visible-tab activity refresh' });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await refresh; await evicted; await paint(); await rendered(C);
    const persisted = nextProjection(C, observed.mark()); await control('/persist'); await consume(await persisted, C); await rendered(C);
    await append(custom(B), B, 'idle-persisted-custom-without-open-session');
    assert.equal((await control('/state')).openCount, beforeEvict, 'idle observation causes zero additional open_session requests');
    const diskFailed = nextProjection(null, observed.mark(), 'unavailable'); await control('/disk/failure', { enabled: true });
    await diskFailed; await paint(); await rendered(B);
    const diskRecovered = nextProjection(B, observed.mark()); await control('/disk/failure', { enabled: false }); await consume(await diskRecovered, B);
    assert.equal((await control('/state')).openCount, beforeEvict, 'disk failure/recovery never wakes provider');
    await capture('desktop-idle-recovery');
    // Breakpoint remount is allowed to attach; the no-wake assertion above is
    // deliberately measured before any user-visible reattachment.
    if (await page.locator('.th-sidebar-nav .th-sidebar-toggle').count()) {
      const collapsed = await arm(page, () => !!document.querySelector('.th-sidebar--collapsed'));
      await page.locator('.th-sidebar-nav .th-sidebar-toggle').click(); await done(page, collapsed);
    }
    const mobileProjection = nextProjection(B, observed.mark());
    await page.setViewportSize({ width: 390, height: 844 }); await consume(await mobileProjection, B, { rebind: true });
    await shelf(); await rendered(B); await capture('mobile-390x844');
    await append(custom(C), C, 'mobile-newer-completion'); await capture('mobile-completed');
    await append(custom([]), [], 'mobile-explicit-clear'); await capture('mobile-clear');
    assert.deepEqual(report.errors, []); report.passed = true;
  } catch (error) { failure = error; report.error = { message: error.message, stack: error.stack }; }
  finally {
    const clean = async (key, action) => { try { cleanup[key] = await action() ?? true; } catch (error) { cleanup.errors.push({ key, error: String(error) }); } };
    if (failure && page && !page.isClosed()) await clean('failureCapture', async () => { await page.screenshot({ path: join(evidenceDir, 'failure.png') }); await writeFile(join(evidenceDir, 'failure.html'), await page.content()); });
    if (page && !page.isClosed()) await clean('domObservers', () => page.evaluate(() => window.__todoQA?.stop()));
    if (observed) { observed.stop(); cleanup.socketObserverStopped = true; }
    if (context) await clean('contextClosed', () => context.close());
    if (browser && !suppliedBrowser) await clean('browserClosed', async () => { await browser.close(); assert.equal(browser.isConnected(), false); });
    if (suppliedBrowser) cleanup.callerBrowserRetained = true;
    if (fixture) await clean('fixture', () => fixture.stop());
    report.passed = report.passed && !failure && cleanup.errors.length === 0; report.finishedAt = new Date().toISOString();
    await save(evidenceDir, 'websocket-timeline.json', observed?.timeline ?? []);
    await save(evidenceDir, 'browser-errors.json', report.errors); await save(evidenceDir, 'cleanup.json', cleanup); await save(evidenceDir, 'browser-actions.json', report);
  }
  if (failure) throw failure; assert.deepEqual(cleanup.errors, [], 'QA cleanup failed'); return { ...report, cleanup };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const result = await run(parseArgs(process.argv.slice(2))); console.log(JSON.stringify({ passed: result.passed, cleanup: result.cleanup }, null, 2)); }
  catch (error) { console.error(error.stack); process.exitCode = 1; }
}
