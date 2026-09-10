import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';

const repo = resolve(import.meta.dirname, '../..');
const expectedHead = process.env.QA_EXPECTED_HEAD; // unset: require a clean tree matching the pushed PR head
const driverPath = process.env.QA_PLAYWRIGHT ?? join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs');
const chromePath = process.env.QA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const runFile = 'qa-run.json';
const taskPath = '/api/workspaces/qa-counts/chats/qa-counts-chat/tasks';
const livePath = '/api/sessions/live';
const dagPrefix = '/api/workspaces/qa-counts/chats/qa-counts-chat/dag-runs';
const agentsTabCount = '[data-activity-tab="agents"] .th-activity-tab-count';
const workspaceBadge = '.th-tree-running--workspace';
const runningIDs = Array.from({ length: 50 }, (_, index) => `running-${String(index).padStart(3, '0')}`);
const victimID = 'running-000';
const victimName = 'Running task 001';
const victimRosterName = '(qa-worker) - Running task 001';
const command = promisify(execFile);
const pidExitScript = [
  'import errno, os, select, sys',
  'pid = int(sys.argv[1])',
  'timeout = float(sys.argv[2])',
  'try:',
  '    os.kill(pid, 0)',
  'except ProcessLookupError:',
  '    raise SystemExit(0)',
  'except PermissionError:',
  '    pass',
  'kq = select.kqueue()',
  'try:',
  '    kq.control([select.kevent(pid, filter=select.KQ_FILTER_PROC, flags=select.KQ_EV_ADD, fflags=select.KQ_NOTE_EXIT)], 0)',
  'except OSError as error:',
  '    raise SystemExit(0 if error.errno == errno.ESRCH else 1)',
  'events = kq.control(None, 1, timeout)',
  'raise SystemExit(0 if events else 1)',
].join('\n');

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

// Arm a MutationObserver DOM-state signal and return its id without blocking
// the triggering action. The observer runs check() immediately so an already-
// true persistent state still resolves. Register before the action; await
// doneDOM after. Navigation replaces the document, so re-arm on the new one.
async function armDOM(page, source, args = null, ms = 20_000) {
  return page.evaluate(({ source, args, ms }) => {
    const predicate = (0, eval)(`(${source})`);
    window.__qaDom ??= new Map();
    const id = (window.__qaDomNext = (window.__qaDomNext ?? 0) + 1);
    const promise = new Promise((resolveWait, reject) => {
      let timer;
      const finish = error => {
        clearTimeout(timer); observer.disconnect();
        error ? reject(error) : resolveWait(true);
      };
      const check = () => { try { if (predicate(args)) finish(); } catch (error) { finish(error); } };
      const observer = new MutationObserver(check);
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = setTimeout(() => finish(new Error(`DOM signal deadline: ${source}`)), ms);
      check();
    });
    promise.catch(() => {});
    window.__qaDom.set(id, promise);
    return id;
  }, { source: String(source), args, ms });
}
async function doneDOM(page, id) {
  await page.evaluate(async id => {
    try { await window.__qaDom.get(id); } finally { window.__qaDom.delete(id); }
  }, id);
}
const textIs = ({ selector, expected }) => {
  const node = document.querySelector(selector);
  return node !== null && (node.textContent ?? '').trim() === expected;
};
const absent = ({ selector }) => document.querySelector(selector) === null;
const victimCompletedRow = ({ name }) => [...document.querySelectorAll('[data-activity-tabpanel="agents"] .th-activity-agent')].some(row => {
  const title = row.querySelector('.th-activity-agent-name')?.textContent ?? '';
  const chip = (row.querySelector('.th-activity-chip')?.textContent ?? '').trim();
  return title.includes(name) && chip === 'completed';
});

function namedTask(tasks, id) {
  return (Array.isArray(tasks) ? tasks : []).find(row => row?.task_id === id);
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

async function waitPidExit(pid, ms = 5_000) {
  try {
    await command('python3', ['-c', pidExitScript, String(pid), String(ms / 1000)]);
    return true;
  } catch {
    try { process.kill(pid, 0); return false; } catch { return true; }
  }
}

// Sweep any browser process still holding the QA's isolated temp profile
// (matched by its unique mkdtemp marker) and confirm reaping via kill -0.
// Process-exit waits are kqueue NOTE_EXIT signals with a bounded deadline.
async function sweepChromeProcesses(marker) {
  let pids = [];
  try {
    const { stdout } = await command('pgrep', ['-f', marker]);
    pids = stdout.split('\n').map(line => Number(line.trim())).filter(pid => Number.isInteger(pid) && pid > 0);
  } catch (error) {
    if (error.code !== 1) throw error; // pgrep exits 1 when nothing matches
  }
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  const leftover = [];
  for (const pid of pids) {
    if (await waitPidExit(pid, 5_000)) continue;
    try { process.kill(pid, 'SIGKILL'); } catch {}
    if (!(await waitPidExit(pid, 3_000))) leftover.push(pid);
  }
  return { swept: leftover.length === 0, leftover };
}

async function run(evidenceDir) {
  evidenceDir = resolve(evidenceDir); await mkdir(evidenceDir, { recursive: true });
  const report = {
    status: 'BLOCKED', task: 'exact-counts-tab-gated-full-fetch', head: null,
    tree: null, fencing: null, startedAt: new Date().toISOString(), items: [], artifacts: {}, cleanup: {}, errors: [],
  };
  const item = (id, name, passed, evidence, details = {}) => report.items.push({ id, name, status: passed ? 'PASS' : 'FAIL', evidence, ...details });
  let fixtureRoot, profile, child, childExit, url, context, page, failure, jar, refused;
  let stdout = '', stderr = '';
  const network = eventLog(), wire = eventLog();
  const taskGETs = () => network.rows.filter(row => row.event === 'request' && row.path === taskPath).length;
  const dagGETs = () => network.rows.filter(row => row.event === 'request' && row.path.startsWith(dagPrefix)).length;
  try {
    const head = (await command('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    const treeStatus = (await command('git', ['status', '--short'], { cwd: repo })).stdout;
    const dirty = treeStatus.split('\n').filter(Boolean);
    let prHead = null;
    try {
      const pr = await command('gh', ['pr', 'view', '--json', 'headRefOid'], { cwd: repo });
      prHead = JSON.parse(pr.stdout).headRefOid;
    } catch (error) {
      refused = true;
      report.head = head;
      report.tree = { head, prHead: null, dirty, clean: dirty.length === 0 };
      report.status = 'FAIL';
      report.errors.push({ message: `failed to fetch pushed PR head via gh: ${error.message}` });
      failure = error;
      return report;
    }
    report.head = head;
    report.tree = { head, prHead, dirty, clean: dirty.length === 0 };
    if (expectedHead !== undefined && head !== expectedHead) {
      refused = true;
      report.status = 'FAIL';
      report.errors.push({ message: `HEAD ${head} differs from QA_EXPECTED_HEAD ${expectedHead}` });
      failure = new Error(`QA refused: HEAD ${head} differs from QA_EXPECTED_HEAD ${expectedHead}`);
      return report;
    }
    if (dirty.length > 0 || head !== prHead) {
      refused = true;
      report.status = 'FAIL';
      const reasons = [];
      if (dirty.length > 0) reasons.push(`git status --short is non-empty (${dirty.length} entries)`);
      if (head !== prHead) reasons.push(`HEAD ${head} differs from pushed PR head ${prHead}`);
      report.errors.push({ message: `QA refused: ${reasons.join('; ')}`, dirty, head, prHead });
      failure = new Error(`QA refused: ${reasons.join('; ')}`);
      return report;
    }
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
    await context.addInitScript(() => { localStorage.setItem('th-lang', 'en'); });
    context.setDefaultTimeout(20_000); page = context.pages()[0];
    page.on('request', request => {
      const parsed = new URL(request.url());
      if (parsed.origin === url) network.add({ event: 'request', method: request.method(), path: parsed.pathname + parsed.search, at: new Date().toISOString() });
    });
    page.on('response', response => {
      const parsed = new URL(response.url());
      if (parsed.origin !== url) return;
      const path = parsed.pathname + parsed.search;
      network.add({ event: 'response', method: response.request().method(), path, status: response.status(), at: new Date().toISOString() });
      if (path === taskPath && response.status() === 200) {
        response.json().then(body => {
          network.add({ event: 'roster', path, status: 200, body, at: new Date().toISOString() });
        }).catch(() => {});
      }
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
    // Authority, activity, and closed-tab count waits are registered BEFORE emit.
    const activityFrame = wire.wait((_, row) => row.direction === 'received' && row.frame?.type === 'sessions.activity' && row.frame.taskDigest?.running_count === 50, 'exact activity frame');
    const authorityFrame = wire.wait((_, row) => row.direction === 'received' && row.frame?.type === 'extensionEvent' && row.frame?.name === 'omo.task.updated' && row.frame?.data?.agent_running_count !== undefined, 'attached count authority frame');
    const closedCount50 = await armDOM(page, textIs, { selector: agentsTabCount, expected: '50/600' });
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
    // zero-named-rows defect is directly asserted away. The named completion
    // victim is kept inside that bounded live window.
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
    const liveVictim50 = namedTask(authorityRows, victimID);
    assert.equal(liveVictim50?.task_id, victimID);
    assert.equal(liveVictim50?.name, victimName);
    assert.equal(liveVictim50?.status, 'running');
    assert.equal(await page.locator('.th-activity-shelf').getAttribute('data-open'), 'false');
    await doneDOM(page, closedCount50);
    assert.equal((await page.locator(agentsTabCount).textContent())?.trim(), '50/600');
    const closedRosterFetches = network.rows.filter(row => row.event === 'request' && (row.path === taskPath || row.path.startsWith(dagPrefix)));
    assert.deepEqual(closedRosterFetches, []);
    await writeFile(join(evidenceDir, 'attached-count-frame.json'), JSON.stringify(authority, null, 2) + '\n');
    item('3', 'Subagents tab count exists, equals the exact authority while closed, updates live from the attached frame of named rows without any roster fetch', true, ['attached-count-frame.json'], { closedCount: '50/600', rosterFetchesWhileClosed: 0, retainedRows: 512, namedRetainedRows: namedRows.length, namedVictim: { id: victimID, name: victimName, status: 'running' } });

    jar = join(fixtureRoot, 'curl.cookies');
    const curlLogin = await command('curl', ['-sS', '-i', '-c', jar, '-H', 'Content-Type: application/json', '--data', '{"password":"exact-counts-isolated"}', url + '/api/login']);
    await writeFile(join(evidenceDir, 'curl-login.txt'), curlLogin.stdout);
    const curlJSON = async (path, label) => {
      const raw = await command('curl', ['-sS', '-i', '-b', jar, url + path]);
      await writeFile(join(evidenceDir, label), raw.stdout);
      const splitAt = raw.stdout.search(/\r?\n\r?\n/); assert.ok(splitAt >= 0);
      return JSON.parse(raw.stdout.slice(splitAt).replace(/^\r?\n\r?\n/, ''));
    };
    const curlLive = async label => {
      const body = await curlJSON(livePath, `curl-sessions-live${label ? '-' + label : ''}.txt`);
      const row = body.sessions.find(entry => entry.id === 'qa-counts-chat'); assert.ok(row);
      return row.task_digest;
    };
    const initialDigest = await curlLive('');
    assert.equal(initialDigest.running_count, 50); assert.equal(initialDigest.total_count, 600);
    assert.equal(initialDigest.agent_running_count, 50); assert.equal(initialDigest.agent_total_count, 600);
    assert.equal(initialDigest.truncated, true); assert.equal(initialDigest.tasks.length, 512);
    const restVictim50 = namedTask(initialDigest.tasks, victimID);
    assert.equal(restVictim50?.task_id, victimID);
    assert.equal(restVictim50?.status, 'running');
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
    const firstRosterBody = network.wait((_, row) => row.event === 'roster' && row.status === 200, 'single roster body');
    const openCount50 = await armDOM(page, textIs, { selector: agentsTabCount, expected: '50/600' });
    await page.locator('[data-activity-tab="agents"]').click(); await taskResponse;
    await page.locator('[data-activity-roster-status="ready"]').waitFor({ state: 'attached' });
    const firstRoster = await firstRosterBody;
    const rosterRows = page.locator('[data-activity-tabpanel="agents"] .th-activity-agent');
    const rosterNames = await rosterRows.locator('.th-activity-agent-name').allTextContents();
    const expectedRosterNames = Array.from({ length: 50 }, (_, index) => `(qa-worker) - Running task ${String(index + 1).padStart(3, '0')}`);
    assert.deepEqual(expectedRosterNames.filter(name => !rosterNames.includes(name)), [], 'all 50 authoritative roster rows render');
    assert.equal(taskGETs(), 1);
    const openRosterVictim = namedTask(firstRoster.body?.tasks, victimID);
    assert.equal(openRosterVictim?.task_id, victimID);
    assert.equal(openRosterVictim?.name, victimName);
    assert.equal(openRosterVictim?.status, 'running');
    // (b) exact Subagents count asserted while the tab is open.
    assert.equal(await page.locator('.th-activity-shelf').getAttribute('data-open'), 'true');
    await doneDOM(page, openCount50);
    assert.equal((await page.locator(agentsTabCount).textContent())?.trim(), '50/600');
    const openBoundary = network.rows.length;
    await writeFile(join(evidenceDir, 'network-open-agents.json'), JSON.stringify(network.rows.slice(closedBoundary, openBoundary), null, 2) + '\n');
    await page.screenshot({ path: join(evidenceDir, 'agents-full-roster-50.png'), fullPage: true });
    item('6', 'opening Subagents fires exactly one full-roster read, renders all 50 authoritative rows, and keeps the exact count while open', true, ['network-open-agents.json', 'agents-full-roster-50.png'], { taskRequests: 1, authoritativeRosterRows: 50, renderedRowsIncludingDigestHistory: await rosterRows.count(), countWhileOpen: '50/600' });

    const closedCountAfter = await armDOM(page, textIs, { selector: agentsTabCount, expected: '50/600' });
    await page.locator('[data-activity-tab="agents"]').click();
    await page.locator('.th-activity-shelf[data-open="false"]').waitFor({ state: 'attached' });
    // (c) exact Subagents count reasserted after closing the tab.
    await doneDOM(page, closedCountAfter);
    assert.equal((await page.locator(agentsTabCount).textContent())?.trim(), '50/600');
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
    // The previous document is gone; arm on the new document. The 50/600
    // count is a persistent DOM state, so check() resolves if it is already painted.
    const reloadedCount50 = await armDOM(page, textIs, { selector: agentsTabCount, expected: '50/600' });
    await doneDOM(page, reloadedCount50);
    assert.equal((await page.locator(agentsTabCount).textContent())?.trim(), '50/600');
    assert.equal(await page.locator('.th-activity-shelf').getAttribute('data-open'), 'false');
    assert.equal(taskGETs(), 1);
    item('8', 'reattach hydration renders the exact authority on the closed shelf after a generation-fenced reconnect with no additional roster fetch', true, ['browser-websocket.json'], { reloadedCount: '50/600', totalTaskRequests: 1, readySequences: { initial: initialReady.sequence, reload: reloadedReady.sequence } });

    // ---- stage 3: complete one named task, 50 -> 49 ----
    const completionAuthority49 = wire.wait((_, row) => row.direction === 'received' && row.frame?.type === 'extensionEvent' && row.frame?.name === 'omo.task.updated' && row.frame?.data?.running_count === 49, 'completion authority frame 49');
    const completionActivity49 = wire.wait((_, row) => row.direction === 'received' && row.frame?.type === 'sessions.activity' && row.frame?.taskDigest?.running_count === 49, 'completion activity digest 49');
    const count49 = await armDOM(page, textIs, { selector: agentsTabCount, expected: '49/600' });
    const badge49 = await armDOM(page, textIs, { selector: workspaceBadge, expected: '49' });
    const completed = await context.request.post(url + '/__qa/complete', { data: { taskIds: [victimID] } });
    assert.equal(completed.status(), 200, await completed.text());
    const completionReceipt = await completed.json();
    assert.deepEqual(completionReceipt.completed, [victimID]);
    assert.equal(completionReceipt.running, 49);
    const authority49 = await completionAuthority49;
    const activity49 = await completionActivity49;
    assert.equal(authority49.frame.data.running_count, 49); assert.equal(authority49.frame.data.total_count, 600);
    assert.equal(authority49.frame.data.agent_running_count, 49); assert.equal(authority49.frame.data.agent_total_count, 600);
    assert.equal(activity49.frame.taskDigest.running_count, 49); assert.equal(activity49.frame.taskDigest.total_count, 600);
    assert.equal(activity49.frame.taskDigest.agent_running_count, 49); assert.equal(activity49.frame.taskDigest.agent_total_count, 600);
    const attachedVictim49 = namedTask(authority49.frame.data.tasks, victimID);
    assert.equal(attachedVictim49?.task_id, victimID, 'named victim must remain in the attached live projection after completion');
    assert.equal(attachedVictim49?.name, victimName);
    assert.equal(attachedVictim49?.status, 'completed');
    const digestVictim49 = namedTask(activity49.frame.taskDigest.tasks, victimID);
    assert.equal(digestVictim49?.task_id, victimID, 'named victim must remain in the sessions.activity digest after completion');
    assert.equal(digestVictim49?.status, 'completed');
    const digest49 = await curlLive('49');
    assert.equal(digest49.running_count, 49); assert.equal(digest49.total_count, 600);
    assert.equal(digest49.agent_running_count, 49); assert.equal(digest49.agent_total_count, 600);
    const restVictim49 = namedTask(digest49.tasks, victimID);
    assert.equal(restVictim49?.task_id, victimID, 'named victim must remain in the REST live digest after completion');
    assert.equal(restVictim49?.status, 'completed');
    // The tab is closed: the decrement must arrive without any roster read.
    await doneDOM(page, count49);
    await doneDOM(page, badge49);
    assert.equal((await page.locator(agentsTabCount).textContent())?.trim(), '49/600');
    assert.equal((await page.locator(workspaceBadge).textContent())?.trim(), '49');
    assert.equal(taskGETs(), 1);
    const closedDecrementTaskGets = taskGETs();
    // Application roster GET (not the fixture-control acknowledgement): the
    // chat-tasks surface carries the victim identity and terminal status while
    // the SPA tab stays closed, so this does not count as a page roster fetch.
    const roster49 = await curlJSON(taskPath, 'curl-chat-tasks-49.txt');
    const rosterVictim49 = namedTask(roster49.tasks, victimID);
    assert.equal(rosterVictim49?.task_id, victimID);
    assert.equal(rosterVictim49?.name, victimName);
    assert.equal(rosterVictim49?.status, 'completed');
    assert.equal(taskGETs(), closedDecrementTaskGets, 'the application roster curl must not appear as a page roster fetch');
    // Rendered Subagents row: reopen after the closed-tab decrement so the
    // existing closed-tab GET==1 assertion still holds, then observe the
    // victim on the SPA roster GET body and the painted row.
    const completionRoster = network.wait((_, row) => row.event === 'roster' && row.status === 200, 'completion roster body');
    const completionRosterResponse = network.wait((_, row) => row.event === 'response' && row.path === taskPath && row.status === 200, 'completion roster response');
    const victimRow = await armDOM(page, victimCompletedRow, { name: victimRosterName });
    const openCount49 = await armDOM(page, textIs, { selector: agentsTabCount, expected: '49/600' });
    await page.locator('[data-activity-tab="agents"]').click();
    await completionRosterResponse;
    await page.locator('[data-activity-roster-status="ready"]').waitFor({ state: 'attached' });
    const paintedRoster = await completionRoster;
    const paintedVictim = namedTask(paintedRoster.body?.tasks, victimID);
    assert.equal(paintedVictim?.task_id, victimID);
    assert.equal(paintedVictim?.name, victimName);
    assert.equal(paintedVictim?.status, 'completed');
    await doneDOM(page, victimRow);
    await doneDOM(page, openCount49);
    assert.equal((await page.locator(agentsTabCount).textContent())?.trim(), '49/600');
    assert.equal(taskGETs(), 2);
    await writeFile(join(evidenceDir, 'completion-roster-49.json'), JSON.stringify(paintedRoster.body, null, 2) + '\n');
    await page.screenshot({ path: join(evidenceDir, 'completion-named-row-49.png'), fullPage: true });
    await page.locator('[data-activity-tab="agents"]').click();
    await page.locator('.th-activity-shelf[data-open="false"]').waitFor({ state: 'attached' });
    assert.equal(taskGETs(), 2);
    await writeFile(join(evidenceDir, 'completion-frame-49.json'), JSON.stringify({ authority: authority49, activity: activity49 }, null, 2) + '\n');
    await page.screenshot({ path: join(evidenceDir, 'completion-49.png'), fullPage: true });
    item('9', 'a named task completion decrements the authority, digest, REST row, tab count and sidebar badge by exactly one with the tab closed, and the named victim is completed on the roster GET and rendered Subagents row', true, ['completion-frame-49.json', 'curl-sessions-live-49.txt', 'curl-chat-tasks-49.txt', 'completion-roster-49.json', 'completion-49.png', 'completion-named-row-49.png'], {
      completedTask: victimID, authorityCounts: '49/600', digestCounts: '49/600', restCounts: '49/600', tabCount: '49/600', sidebarBadge: '49',
      taskRequestsAtClosedDecrement: closedDecrementTaskGets, totalTaskRequests: 2,
      namedVictim: { id: victimID, name: victimName, status: 'completed', surfaces: ['attached live projection', 'sessions.activity digest', 'REST live digest', 'chat-tasks roster GET', 'rendered Subagents row'] },
    });

    // ---- stage 4: drain the remaining named tasks, 49 -> 0 ----
    const completionAuthority0 = wire.wait((_, row) => row.direction === 'received' && row.frame?.type === 'extensionEvent' && row.frame?.name === 'omo.task.updated' && row.frame?.data?.running_count === 0, 'completion authority frame 0');
    const completionActivity0 = wire.wait((_, row) => row.direction === 'received' && row.frame?.type === 'sessions.activity' && row.frame?.taskDigest?.running_count === 0, 'completion activity digest 0');
    const count0 = await armDOM(page, textIs, { selector: agentsTabCount, expected: '0/600' });
    const badgeGone = await armDOM(page, absent, { selector: workspaceBadge });
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
    await doneDOM(page, count0);
    await doneDOM(page, badgeGone);
    assert.equal((await page.locator(agentsTabCount).textContent())?.trim(), '0/600');
    // Zero running: the sidebar badge must be removed from the DOM entirely.
    assert.equal(await page.locator(workspaceBadge).count(), 0);
    assert.equal(taskGETs(), 2);
    await writeFile(join(evidenceDir, 'completion-frame-zero.json'), JSON.stringify({ authority: authority0, activity: activity0 }, null, 2) + '\n');
    await page.screenshot({ path: join(evidenceDir, 'zero-running-badge-removed.png'), fullPage: true });
    item('10', 'draining the remaining named tasks yields a 0/600 authority, digest and REST row, a 0/600 tab count, and a removed zero-running sidebar badge', true, ['completion-frame-zero.json', 'curl-sessions-live-zero.txt', 'zero-running-badge-removed.png'], { completedTasks: 49, authorityCounts: '0/600', restCounts: '0/600', tabCount: '0/600', sidebarBadge: 'removed' });

    // ---- final audits: tab gate held for the whole capture ----
    assert.equal(taskGETs(), 2);
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
      completion49: 'completion-frame-49.json', completionZero: 'completion-frame-zero.json', completionRoster: 'completion-roster-49.json',
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
    if (!refused) {
      const sweep = report.cleanup.chromeSweep;
      const cleanupPassed = report.cleanup.browserContextClosed === true
        && sweep !== undefined && sweep.error === undefined && (sweep.swept === true || (sweep.leftover ?? []).length === 0)
        && report.cleanup.browserProfileRemoved === true && report.cleanup.fixtureProcess?.exited === true
        && report.cleanup.fixtureProcess?.kill0 !== 'still-alive' && report.cleanup.portReleased === true && report.cleanup.fixtureRootRemoved === true;
      if (!cleanupPassed || report.errors.length > 0 || report.items.length !== 10 || report.items.some(row => row.status !== 'PASS')) report.status = 'BLOCKED';
    }
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
