import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';

const repo = resolve(import.meta.dirname, '../..');
const expectedHead = process.env.QA_EXPECTED_HEAD; // unset: bind evidence to the current commit and record the tree state
const driverPath = process.env.QA_PLAYWRIGHT ?? join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs');
const chromePath = process.env.QA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const runFile = 'qa-run.json';
const taskPath = '/api/workspaces/qa-counts/chats/qa-counts-chat/tasks';
const livePath = '/api/sessions/live';
const dagPrefix = '/api/workspaces/qa-counts/chats/qa-counts-chat/dag-runs';
const agentsTabCount = '[data-activity-tab="agents"] .th-activity-tab-count';
const workspaceBadge = '.th-tree-running--workspace';
const runningIDs = Array.from({ length: 50 }, (_, index) => `running-${String(index).padStart(3, '0')}`);
const command = promisify(execFile);

function deadline(promise, label, ms = 20_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline`)), ms); })])
    .finally(() => clearTimeout(timer));
}

// Every wait is registration-fenced: only rows appended after the wait was
// registered can resolve it, so an earlier ready or authority frame can never
// satisfy a later generation's wait. Register each wait BEFORE the action that
// must produce its event; never after.
function eventLog() {
  const rows = [], waiters = new Set();
  function add(row) {
    row.sequence = rows.length + 1;
    rows.push(row);
    for (const waiter of [...waiters]) if (row.sequence > waiter.fence && waiter.predicate(rows, row)) {
      waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(row);
    }
  }
  function wait(predicate, label, ms = 20_000) {
    const fence = rows.length;
    return new Promise((resolve, reject) => {
      const waiter = {
        fence, predicate, resolve,
        timer: setTimeout(() => { waiters.delete(waiter); reject(new Error(`${label} deadline (fenced after row ${fence})`)); }, ms),
      };
      waiters.add(waiter);
    });
  }
  return { rows, add, wait };
}

async function untilText(page, selector, expected, ms = 20_000) {
  await page.waitForFunction(
    ({ selector, expected }) => {
      const node = document.querySelector(selector);
      return node !== null && (node.textContent ?? '').trim() === expected;
    },
    { selector, expected },
    { polling: 100, timeout: ms },
  );
}

async function untilAbsent(page, selector, ms = 20_000) {
  await page.waitForFunction(selector => document.querySelector(selector) === null, selector, { polling: 100, timeout: ms });
}

async function portReleased(port) {
  return new Promise((resolvePort, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); reject(new Error(`port ${port} is still accepting connections`)); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolvePort(true) : reject(error));
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error(`port ${port} release check timed out`)); });
  });
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

// Sweep any browser process still holding the QA's isolated temp profile
// (matched by its unique mkdtemp marker) and confirm reaping via kill -0.
async function sweepChromeProcesses(marker) {
  let pids = [];
  try {
    const { stdout } = await command('pgrep', ['-f', marker]);
    pids = stdout.split('\n').map(line => Number(line.trim())).filter(pid => Number.isInteger(pid) && pid > 0);
  } catch (error) {
    if (error.code !== 1) throw error; // pgrep exits 1 when nothing matches
  }
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  for (let attempt = 0; attempt < 25 && pids.length > 0; attempt++) {
    pids = pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    if (pids.length === 0) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { swept: pids.length === 0, leftover: pids };
}

async function run(evidenceDir) {
  evidenceDir = resolve(evidenceDir); await mkdir(evidenceDir, { recursive: true });
  const report = {
    status: 'BLOCKED', task: 'exact-counts-tab-gated-full-fetch', head: null,
    tree: null, fencing: null, startedAt: new Date().toISOString(), items: [], artifacts: {}, cleanup: {}, errors: [],
  };
  const item = (id, name, passed, evidence, details = {}) => report.items.push({ id, name, status: passed ? 'PASS' : 'FAIL', evidence, ...details });
  let fixtureRoot, profile, child, childExit, url, context, page, failure, jar;
  let stdout = '', stderr = '';
  const network = eventLog(), wire = eventLog();
  const taskGETs = () => network.rows.filter(row => row.event === 'request' && row.path === taskPath).length;
  const dagGETs = () => network.rows.filter(row => row.event === 'request' && row.path.startsWith(dagPrefix)).length;
  try {
    const head = (await command('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    const treeStatus = (await command('git', ['status', '--porcelain'], { cwd: repo })).stdout;
    if (expectedHead !== undefined) assert.equal(head, expectedHead);
    report.head = head;
    // r4 runs against the combined G1/G2/G3 fix lanes, which are complete in
    // this worktree but uncommitted by DAG order; the recorded dirty-file list
    // plus the head binds this evidence to exactly the code under test.
    report.tree = {
      head,
      dirty: treeStatus.split('\n').filter(Boolean),
      note: 'fix lanes land uncommitted by DAG order; evidence binds to head plus this recorded tree state',
    };
    fixtureRoot = await mkdtemp(join(tmpdir(), 'exact-counts-fixture-'));
    profile = await mkdtemp(join(tmpdir(), 'exact-counts-chrome-'));
    const binary = join(fixtureRoot, 'fixture');
    const build = await command('go', ['build', '-o', binary, 'test/qa/exact-counts-tab-gate-fixture.go'], { cwd: repo });
    await writeFile(join(evidenceDir, 'fixture-build.log'), build.stdout + build.stderr);
    await mkdir(join(fixtureRoot, 'state'));
    child = spawn(binary, ['--root', join(fixtureRoot, 'state'), '--listen', '127.0.0.1:0'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    childExit = new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolveExit({ code, signal })); });
    const ready = new Promise((resolveReady, reject) => {
      child.stdout.on('data', chunk => { stdout += chunk; const found = /EXACT_COUNTS_QA_READY (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout); if (found) resolveReady(found[1]); });
      child.stderr.on('data', chunk => { stderr += chunk; });
      childExit.then(result => reject(new Error(`fixture exited before readiness: ${JSON.stringify(result)} ${stderr}`)));
    });
    url = await deadline(ready, 'fixture readiness', 30_000);

    const { chromium } = await import(pathToFileURL(driverPath).href);
    context = await chromium.launchPersistentContext(profile, { executablePath: chromePath, headless: true, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', timeout: 30_000 });
    context.setDefaultTimeout(20_000); page = context.pages()[0];
    page.on('request', request => {
      const parsed = new URL(request.url());
      if (parsed.origin === url) network.add({ event: 'request', method: request.method(), path: parsed.pathname + parsed.search, at: new Date().toISOString() });
    });
    page.on('response', response => {
      const parsed = new URL(response.url());
      if (parsed.origin === url) network.add({ event: 'response', method: response.request().method(), path: parsed.pathname + parsed.search, status: response.status(), at: new Date().toISOString() });
    });
    page.on('websocket', socket => {
      socket.on('framereceived', event => {
        try { wire.add({ direction: 'received', url: socket.url(), frame: JSON.parse(String(event.payload)), at: new Date().toISOString() }); } catch {}
      });
      socket.on('framesent', event => {
        try { wire.add({ direction: 'sent', url: socket.url(), frame: JSON.parse(String(event.payload)), at: new Date().toISOString() }); } catch {}
      });
    });
    const login = await context.request.post(url + '/api/login', { data: { password: 'exact-counts-isolated' } });
    assert.equal(login.status(), 200);

    // ---- stage 0: attach, then emit the named live fixture ----
    const readyFrame = wire.wait((_, row) => row.direction === 'received' && row.frame?.type === 'ready' && row.frame.sessionId === 'qa-counts-chat', 'chat ready');
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const initialReady = await readyFrame;
    // Nothing has been emitted yet: the closed shelf must not pin initial zeros.
    await page.locator('.th-chat-input-inner').waitFor({ state: 'visible' });
    assert.equal(await page.locator(agentsTabCount).count(), 0);
    // Both authority waits are registered BEFORE the emit action.
    const activityFrame = wire.wait((_, row) => row.direction === 'received' && row.frame?.type === 'sessions.activity' && row.frame.taskDigest?.running_count === 50, 'exact activity frame');
    const authorityFrame = wire.wait((_, row) => row.direction === 'received' && row.frame?.type === 'extensionEvent' && row.frame?.name === 'omo.task.updated' && row.frame?.data?.agent_running_count !== undefined, 'attached count authority frame');
    const emitted = await context.request.post(url + '/__qa/emit');
    assert.equal(emitted.status(), 200, await emitted.text());
    const wsReceipt = await activityFrame;
    const wsDigest = wsReceipt.frame.taskDigest;
    assert.equal(wsDigest.running_count, 50); assert.equal(wsDigest.total_count, 600); assert.equal(wsDigest.truncated, true); assert.equal(wsDigest.tasks.length, 512);
    assert.equal(wsDigest.agent_running_count, 50); assert.equal(wsDigest.agent_total_count, 600);
    if (wsReceipt.frame.dagDigest !== undefined) {
      assert.equal(wsReceipt.frame.dagDigest.agent_running_count, 50);
      assert.equal(wsReceipt.frame.dagDigest.agent_total_count, 600);
    }
    await writeFile(join(evidenceDir, 'sessions-activity-frame.json'), JSON.stringify(wsReceipt, null, 2) + '\n');
    item('2', 'sessions.activity carries the exact pre-truncation scalars', true, ['sessions-activity-frame.json'], { runningCount: 50, totalCount: 600, agentRunningCount: 50, agentTotalCount: 600, retainedRows: 512, truncated: true });

    // Count-only authority reaches the attached pane while every tab stays
    // closed. The retained rows are valid NAMED live rows, so the review's
    // zero-named-rows defect is directly asserted away.
    const authority = await authorityFrame;
    const authorityData = authority.frame.data;
    assert.equal(authorityData.running_count, 50);
    assert.equal(authorityData.total_count, 600);
    assert.equal(authorityData.agent_running_count, 50);
    assert.equal(authorityData.agent_total_count, 600);
    const authorityRows = Array.isArray(authorityData.tasks) ? authorityData.tasks : [];
    assert.equal(authorityRows.length, 512);
    const namedRows = authorityRows.filter(row => typeof row?.name === 'string' && row.name.length > 0);
    assert.equal(namedRows.length, 512, 'every retained live row must be a named row');
    assert.equal(await page.locator('.th-activity-shelf').getAttribute('data-open'), 'false');
    const closedAgentsCount = page.locator(agentsTabCount);
    await closedAgentsCount.waitFor({ state: 'visible' });
    assert.equal((await closedAgentsCount.textContent())?.trim(), '50/600');
    const closedRosterFetches = network.rows.filter(row => row.event === 'request' && (row.path === taskPath || row.path.startsWith(dagPrefix)));
    assert.deepEqual(closedRosterFetches, []);
    await writeFile(join(evidenceDir, 'attached-count-frame.json'), JSON.stringify(authority, null, 2) + '\n');
    item('3', 'Subagents tab count exists, equals the exact authority while closed, updates live from the attached frame of named rows without any roster fetch', true, ['attached-count-frame.json'], { closedCount: '50/600', rosterFetchesWhileClosed: 0, retainedRows: 512, namedRetainedRows: namedRows.length });

    jar = join(fixtureRoot, 'curl.cookies');
    const curlLogin = await command('curl', ['-sS', '-i', '-c', jar, '-H', 'Content-Type: application/json', '--data', '{"password":"exact-counts-isolated"}', url + '/api/login']);
    await writeFile(join(evidenceDir, 'curl-login.txt'), curlLogin.stdout);
    const curlLive = async label => {
      const live = await command('curl', ['-sS', '-i', '-b', jar, url + livePath]);
      await writeFile(join(evidenceDir, `curl-sessions-live${label ? '-' + label : ''}.txt`), live.stdout);
      const splitAt = live.stdout.search(/\r?\n\r?\n/); assert.ok(splitAt >= 0);
      const body = JSON.parse(live.stdout.slice(splitAt).replace(/^\r?\n\r?\n/, ''));
      const row = body.sessions.find(entry => entry.id === 'qa-counts-chat'); assert.ok(row);
      return row.task_digest;
    };
    const initialDigest = await curlLive('');
    assert.equal(initialDigest.running_count, 50); assert.equal(initialDigest.total_count, 600);
    assert.equal(initialDigest.agent_running_count, 50); assert.equal(initialDigest.agent_total_count, 600);
    assert.equal(initialDigest.truncated, true); assert.equal(initialDigest.tasks.length, 512);
    item('1', 'authenticated curl -i preserves exact counts with a truncated row list', true, ['curl-login.txt', 'curl-sessions-live.txt'], { runningCount: 50, totalCount: 600, agentRunningCount: 50, agentTotalCount: 600, retainedRows: 512, truncated: true });

    await network.wait(rows => rows.filter(row => row.event === 'response' && row.path === livePath && row.status === 200).length >= 3, 'three polling responses', 15_000);
    const closedBoundary = network.rows.length;
    const closedWindow = network.rows.slice(0, closedBoundary);
    const forbiddenClosed = closedWindow.filter(row => row.event === 'request' && (row.path === taskPath || row.path.startsWith(dagPrefix)));
    assert.equal(await page.locator('.th-activity-shelf').getAttribute('data-open'), 'false');
    assert.deepEqual(forbiddenClosed, []);
    await writeFile(join(evidenceDir, 'network-closed-tabs.json'), JSON.stringify(closedWindow, null, 2) + '\n');
    item('4', 'three closed-tab polling cycles issue no roster or DAG reads', true, ['network-closed-tabs.json'], { pollingResponses: closedWindow.filter(row => row.event === 'response' && row.path === livePath && row.status === 200).length, taskRequests: 0, dagRequests: 0 });

    const badge = page.locator(workspaceBadge);
    await badge.waitFor({ state: 'visible' });
    assert.equal((await badge.textContent())?.trim(), '50');
    const compactMarkers = await page.locator('.th-tree-running, .th-activity-tab-count').allTextContents();
    const partialMarkers = compactMarkers.filter(text => /[?+]/.test(text));
    await page.screenshot({ path: join(evidenceDir, 'sidebar-badge-50.png'), fullPage: true });
    item('5', 'sidebar badge renders exactly 50 with no question-mark or plus marker anywhere', partialMarkers.length === 0, ['sidebar-badge-50.png'], { badge: '50', compactMarkers, partialMarkers });

    // ---- stage 1: open, count while open, close, count after close ----
    assert.equal(taskGETs(), 0);
    const taskResponse = network.wait((_, row) => row.event === 'response' && row.path === taskPath && row.status === 200, 'single roster response');
    await page.locator('[data-activity-tab="agents"]').click(); await taskResponse;
    await page.locator('[data-activity-roster-status="ready"]').waitFor({ state: 'attached' });
    const rosterRows = page.locator('[data-activity-tabpanel="agents"] .th-activity-agent');
    const rosterNames = await rosterRows.locator('.th-activity-agent-name').allTextContents();
    const expectedRosterNames = Array.from({ length: 50 }, (_, index) => `(qa-worker) - Running task ${String(index + 1).padStart(3, '0')}`);
    assert.deepEqual(expectedRosterNames.filter(name => !rosterNames.includes(name)), [], 'all 50 authoritative roster rows render');
    assert.equal(taskGETs(), 1);
    // (b) exact Subagents count asserted while the tab is open.
    assert.equal(await page.locator('.th-activity-shelf').getAttribute('data-open'), 'true');
    await untilText(page, agentsTabCount, '50/600');
    const openBoundary = network.rows.length;
    await writeFile(join(evidenceDir, 'network-open-agents.json'), JSON.stringify(network.rows.slice(closedBoundary, openBoundary), null, 2) + '\n');
    await page.screenshot({ path: join(evidenceDir, 'agents-full-roster-50.png'), fullPage: true });
    item('6', 'opening Subagents fires exactly one full-roster read, renders all 50 authoritative rows, and keeps the exact count while open', true, ['network-open-agents.json', 'agents-full-roster-50.png'], { taskRequests: 1, authoritativeRosterRows: 50, renderedRowsIncludingDigestHistory: await rosterRows.count(), countWhileOpen: '50/600' });

    await page.locator('[data-activity-tab="agents"]').click();
    await page.locator('.th-activity-shelf[data-open="false"]').waitFor({ state: 'attached' });
    // (c) exact Subagents count reasserted after closing the tab.
    await untilText(page, agentsTabCount, '50/600');
    const pollsAtClose = network.rows.filter(row => row.event === 'response' && row.path === livePath && row.status === 200).length;
    await network.wait(rows => rows.filter(row => row.event === 'response' && row.path === livePath && row.status === 200).length >= pollsAtClose + 2, 'two post-close polling responses', 12_000);
    const postClose = network.rows.slice(openBoundary);
    assert.equal(taskGETs(), 1);
    await writeFile(join(evidenceDir, 'network-after-close.json'), JSON.stringify(postClose, null, 2) + '\n');
    item('7', 'closing Subagents stops full-roster reads while scalar polling continues and the exact count stays asserted', true, ['network-after-close.json'], { totalTaskRequests: 1, additionalTaskRequests: 0, countAfterClose: '50/600', additionalPollingResponses: network.rows.filter(row => row.event === 'response' && row.path === livePath && row.status === 200).length - pollsAtClose });

    // ---- stage 2: reload, count after a newly observed reconnect ----
    // Both reload waits are registered BEFORE page.reload and are
    // registration-fenced, so the pre-reload ready frame cannot satisfy them.
    const reloadHello = wire.wait((_, row) => row.direction === 'received' && row.frame?.type === 'hello', 'reloaded connection hello');
    const reloadReady = wire.wait((_, row) => row.direction === 'received' && row.frame?.type === 'ready' && row.frame.sessionId === 'qa-counts-chat', 'reloaded chat ready');
    await page.reload({ waitUntil: 'domcontentloaded' });
    const newHello = await reloadHello;
    const reloadedReady = await reloadReady;
    assert.ok(reloadedReady.sequence > newHello.sequence, 'the reloaded ready must follow its own connection hello');
    assert.ok(reloadedReady.sequence > initialReady.sequence, 'the reloaded ready must be a newly observed frame, not the initial one');
    report.fencing = {
      policy: 'registration-fenced waits: only frames appended after wait() registration resolve it; every wait is registered before its triggering action',
      initialReadySequence: initialReady.sequence,
      reloadHelloSequence: newHello.sequence,
      reloadReadySequence: reloadedReady.sequence,
    };
    // (d) exact Subagents count asserted after the newly observed reconnect.
    await untilText(page, agentsTabCount, '50/600');
    assert.equal(await page.locator('.th-activity-shelf').getAttribute('data-open'), 'false');
    assert.equal(taskGETs(), 1);
    item('8', 'reattach hydration renders the exact authority on the closed shelf after a generation-fenced reconnect with no additional roster fetch', true, ['browser-websocket.json'], { reloadedCount: '50/600', totalTaskRequests: 1, readySequences: { initial: initialReady.sequence, reload: reloadedReady.sequence } });

    // ---- stage 3: complete one named task, 50 -> 49 ----
    const completionAuthority49 = wire.wait((_, row) => row.direction === 'received' && row.frame?.type === 'extensionEvent' && row.frame?.name === 'omo.task.updated' && row.frame?.data?.running_count === 49, 'completion authority frame 49');
    const completionActivity49 = wire.wait((_, row) => row.direction === 'received' && row.frame?.type === 'sessions.activity' && row.frame?.taskDigest?.running_count === 49, 'completion activity digest 49');
    const completed = await context.request.post(url + '/__qa/complete', { data: { taskIds: ['running-000'] } });
    assert.equal(completed.status(), 200, await completed.text());
    const completionReceipt = await completed.json();
    assert.deepEqual(completionReceipt.completed, ['running-000']);
    assert.equal(completionReceipt.running, 49);
    const authority49 = await completionAuthority49;
    const activity49 = await completionActivity49;
    assert.equal(authority49.frame.data.running_count, 49); assert.equal(authority49.frame.data.total_count, 600);
    assert.equal(authority49.frame.data.agent_running_count, 49); assert.equal(authority49.frame.data.agent_total_count, 600);
    assert.equal(activity49.frame.taskDigest.running_count, 49); assert.equal(activity49.frame.taskDigest.total_count, 600);
    assert.equal(activity49.frame.taskDigest.agent_running_count, 49); assert.equal(activity49.frame.taskDigest.agent_total_count, 600);
    const digest49 = await curlLive('49');
    assert.equal(digest49.running_count, 49); assert.equal(digest49.total_count, 600);
    assert.equal(digest49.agent_running_count, 49); assert.equal(digest49.agent_total_count, 600);
    // The tab is closed: the decrement must arrive without any roster read.
    await untilText(page, agentsTabCount, '49/600');
    await untilText(page, workspaceBadge, '49');
    assert.equal(taskGETs(), 1);
    await writeFile(join(evidenceDir, 'completion-frame-49.json'), JSON.stringify({ authority: authority49, activity: activity49 }, null, 2) + '\n');
    await page.screenshot({ path: join(evidenceDir, 'completion-49.png'), fullPage: true });
    item('9', 'a named task completion decrements the authority, digest, REST row, tab count and sidebar badge by exactly one with the tab closed', true, ['completion-frame-49.json', 'curl-sessions-live-49.txt', 'completion-49.png'], { completedTask: 'running-000', authorityCounts: '49/600', digestCounts: '49/600', restCounts: '49/600', tabCount: '49/600', sidebarBadge: '49', totalTaskRequests: 1 });

    // ---- stage 4: drain the remaining named tasks, 49 -> 0 ----
    const completionAuthority0 = wire.wait((_, row) => row.direction === 'received' && row.frame?.type === 'extensionEvent' && row.frame?.name === 'omo.task.updated' && row.frame?.data?.running_count === 0, 'completion authority frame 0');
    const completionActivity0 = wire.wait((_, row) => row.direction === 'received' && row.frame?.type === 'sessions.activity' && row.frame?.taskDigest?.running_count === 0, 'completion activity digest 0');
    const drained = await context.request.post(url + '/__qa/complete', { data: { taskIds: runningIDs.slice(1) } });
    assert.equal(drained.status(), 200, await drained.text());
    const drainedReceipt = await drained.json();
    assert.equal(drainedReceipt.running, 0);
    assert.equal(drainedReceipt.completed.length, 49);
    const authority0 = await completionAuthority0;
    const activity0 = await completionActivity0;
    assert.equal(authority0.frame.data.running_count, 0); assert.equal(authority0.frame.data.total_count, 600);
    assert.equal(authority0.frame.data.agent_running_count, 0); assert.equal(authority0.frame.data.agent_total_count, 600);
    assert.equal(activity0.frame.taskDigest.running_count, 0); assert.equal(activity0.frame.taskDigest.total_count, 600);
    assert.equal(activity0.frame.taskDigest.agent_running_count, 0); assert.equal(activity0.frame.taskDigest.agent_total_count, 600);
    const digestZero = await curlLive('zero');
    assert.equal(digestZero.running_count, 0); assert.equal(digestZero.total_count, 600);
    assert.equal(digestZero.agent_running_count, 0); assert.equal(digestZero.agent_total_count, 600);
    await untilText(page, agentsTabCount, '0/600');
    // Zero running: the sidebar badge must be removed from the DOM entirely.
    await untilAbsent(page, workspaceBadge);
    assert.equal(await page.locator(workspaceBadge).count(), 0);
    await writeFile(join(evidenceDir, 'completion-frame-zero.json'), JSON.stringify({ authority: authority0, activity: activity0 }, null, 2) + '\n');
    await page.screenshot({ path: join(evidenceDir, 'zero-running-badge-removed.png'), fullPage: true });
    item('10', 'draining the remaining named tasks yields a 0/600 authority, digest and REST row, a 0/600 tab count, and a removed zero-running sidebar badge', true, ['completion-frame-zero.json', 'curl-sessions-live-zero.txt', 'zero-running-badge-removed.png'], { completedTasks: 49, authorityCounts: '0/600', restCounts: '0/600', tabCount: '0/600', sidebarBadge: 'removed' });

    // ---- final audits: tab gate held for the whole capture ----
    assert.equal(taskGETs(), 1);
    assert.equal(dagGETs(), 0);
    const zeroAuthorityFrames = wire.rows.filter(row => row.direction === 'received' && row.frame?.type === 'extensionEvent' && row.frame?.name === 'omo.task.updated' && row.frame?.data?.running_count === 0);
    assert.ok(zeroAuthorityFrames.length >= 1, 'the wire capture must hold a 0/600 completion authority frame');
    report.networkTotals = { taskGETs: taskGETs(), dagGETs: dagGETs(), zeroAuthorityFrames: zeroAuthorityFrames.length };
    await writeFile(join(evidenceDir, 'browser-network.json'), JSON.stringify(network.rows, null, 2) + '\n');
    await writeFile(join(evidenceDir, 'browser-websocket.json'), JSON.stringify(wire.rows, null, 2) + '\n');
    const fixtureReceipt = await (await context.request.get(url + '/__qa/receipt')).json();
    await writeFile(join(evidenceDir, 'fixture-traffic.json'), JSON.stringify(fixtureReceipt, null, 2) + '\n');
    report.artifacts = {
      network: 'browser-network.json', websocket: 'browser-websocket.json', fixtureTraffic: 'fixture-traffic.json', fixtureBuild: 'fixture-build.log',
      completion49: 'completion-frame-49.json', completionZero: 'completion-frame-zero.json',
    };
    report.status = 'PASS';
  } catch (error) {
    failure = error; report.errors.push({ message: error.message, stack: error.stack });
    if (page && !page.isClosed()) { try { await page.screenshot({ path: join(evidenceDir, 'failure.png'), fullPage: true }); report.artifacts.failureScreenshot = 'failure.png'; } catch {} }
  } finally {
    if (context) { try { await context.close(); report.cleanup.browserContextClosed = true; } catch (error) { report.cleanup.browserContextClosed = false; report.errors.push({ cleanup: 'browser', error: String(error) }); } }
    try { report.cleanup.chromeSweep = await sweepChromeProcesses('exact-counts-chrome-'); } catch (error) { report.cleanup.chromeSweep = { swept: false, error: String(error) }; report.errors.push({ cleanup: 'chromeSweep', error: String(error) }); }
    if (profile) { try { await rm(profile, { recursive: true, force: true }); report.cleanup.browserProfileRemoved = !(await exists(profile)); } catch (error) { report.cleanup.browserProfileRemoved = false; report.errors.push({ cleanup: 'profile', error: String(error) }); } }
    if (child) {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        const result = await deadline(childExit, 'fixture shutdown', 12_000);
        let kill0 = 'unknown';
        try { process.kill(child.pid, 0); kill0 = 'still-alive'; } catch (error) { kill0 = error?.code ?? String(error); }
        report.cleanup.fixtureProcess = { pid: child.pid, ...result, exited: true, kill0 };
      } catch (error) {
        child.kill('SIGKILL');
        report.cleanup.fixtureProcess = { pid: child.pid, exited: false, error: String(error) };
        report.errors.push({ cleanup: 'fixtureProcess', error: String(error) });
      }
    }
    if (url) { try { report.cleanup.portReleased = await portReleased(Number(new URL(url).port)); } catch (error) { report.cleanup.portReleased = false; report.errors.push({ cleanup: 'port', error: String(error) }); } }
    await writeFile(join(evidenceDir, 'fixture-stdout.log'), stdout); await writeFile(join(evidenceDir, 'fixture-stderr.log'), stderr);
    if (fixtureRoot) { try { await rm(fixtureRoot, { recursive: true, force: true }); report.cleanup.fixtureRootRemoved = !(await exists(fixtureRoot)); } catch (error) { report.cleanup.fixtureRootRemoved = false; report.errors.push({ cleanup: 'fixtureRoot', error: String(error) }); } }
    report.cleanup.receiptNote = 'browser context closed, isolated chrome profile swept by unique temp marker and removed, fixture SIGTERMed and reaped (kill -0), port release verified, temp fixture root removed';
    report.finishedAt = new Date().toISOString();
    const sweep = report.cleanup.chromeSweep;
    const cleanupPassed = report.cleanup.browserContextClosed === true
      && sweep !== undefined && sweep.error === undefined && (sweep.swept === true || (sweep.leftover ?? []).length === 0)
      && report.cleanup.browserProfileRemoved === true && report.cleanup.fixtureProcess?.exited === true
      && report.cleanup.fixtureProcess?.kill0 !== 'still-alive' && report.cleanup.portReleased === true && report.cleanup.fixtureRootRemoved === true;
    if (!cleanupPassed || report.errors.length > 0 || report.items.length !== 10 || report.items.some(row => row.status !== 'PASS')) report.status = 'BLOCKED';
    await writeFile(join(evidenceDir, runFile), JSON.stringify(report, null, 2) + '\n');
  }
  if (failure) throw failure;
  assert.equal(report.status, 'PASS');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const evidence = process.argv[2];
  if (!evidence) { console.error('usage: node test/qa/exact-counts-tab-gate.mjs EVIDENCE_DIR'); process.exit(2); }
  try { console.log(JSON.stringify(await run(evidence), null, 2)); } catch (error) { console.error(error.stack); process.exitCode = 1; }
}

export { run };
