import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';

const repo = resolve(import.meta.dirname, '../..');
const expectedHead = process.env.QA_EXPECTED_HEAD; // unset: bind evidence to the current commit, requiring a clean tree
const driverPath = process.env.QA_PLAYWRIGHT ?? join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs');
const chromePath = process.env.QA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const runFile = 'qa-run.json';
const taskPath = '/api/workspaces/qa-counts/chats/qa-counts-chat/tasks';
const livePath = '/api/sessions/live';
const dagPrefix = '/api/workspaces/qa-counts/chats/qa-counts-chat/dag-runs';
const command = promisify(execFile);

function deadline(promise, label, ms = 20_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline`)), ms); })])
    .finally(() => clearTimeout(timer));
}

function eventLog() {
  const rows = [], waiters = new Set();
  function add(row) {
    rows.push(row);
    for (const waiter of [...waiters]) if (waiter.predicate(rows, row)) {
      waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(row);
    }
  }
  function wait(predicate, label, ms = 20_000) {
    const existing = rows.find((row, index) => predicate(rows.slice(0, index + 1), row));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error(`${label} deadline`)); }, ms) };
      waiters.add(waiter);
    });
  }
  return { rows, add, wait };
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

async function run(evidenceDir) {
  evidenceDir = resolve(evidenceDir); await mkdir(evidenceDir, { recursive: true });
  const report = { status: 'FAIL', task: 'exact-counts-tab-gated-full-fetch', head: null, startedAt: new Date().toISOString(), items: [], artifacts: {}, cleanup: {}, errors: [] };
  const item = (id, name, passed, evidence, details = {}) => report.items.push({ id, name, status: passed ? 'PASS' : 'FAIL', evidence, ...details });
  let fixtureRoot, profile, child, childExit, url, context, page, failure;
  let stdout = '', stderr = '';
  const network = eventLog(), wire = eventLog();
  try {
    const head = (await command('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    const status = (await command('git', ['status', '--porcelain'], { cwd: repo })).stdout;
    assert.equal(status, '', 'final QA requires a clean committed tree');
    if (expectedHead !== undefined) assert.equal(head, expectedHead);
    report.head = head;
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
      if (parsed.origin === url) network.add({ sequence: network.rows.length + 1, event: 'request', method: request.method(), path: parsed.pathname + parsed.search, at: new Date().toISOString() });
    });
    page.on('response', response => {
      const parsed = new URL(response.url());
      if (parsed.origin === url) network.add({ sequence: network.rows.length + 1, event: 'response', method: response.request().method(), path: parsed.pathname + parsed.search, status: response.status(), at: new Date().toISOString() });
    });
    page.on('websocket', socket => {
      socket.on('framereceived', event => {
        try { wire.add({ sequence: wire.rows.length + 1, direction: 'received', url: socket.url(), frame: JSON.parse(String(event.payload)), at: new Date().toISOString() }); } catch {}
      });
      socket.on('framesent', event => {
        try { wire.add({ sequence: wire.rows.length + 1, direction: 'sent', url: socket.url(), frame: JSON.parse(String(event.payload)), at: new Date().toISOString() }); } catch {}
      });
    });
    const login = await context.request.post(url + '/api/login', { data: { password: 'exact-counts-isolated' } });
    assert.equal(login.status(), 200);
    const readyFrame = wire.wait((_, row) => row.direction === 'received' && row.frame?.type === 'ready' && row.frame.sessionId === 'qa-counts-chat', 'chat ready');
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await readyFrame;
    const activityFrame = wire.wait((_, row) => row.direction === 'received' && row.frame?.type === 'sessions.activity' && row.frame.taskDigest?.running_count === 50, 'exact activity frame');
    const emitted = await context.request.post(url + '/__qa/emit');
    assert.equal(emitted.status(), 200, await emitted.text());
    const wsReceipt = await activityFrame;
    const wsDigest = wsReceipt.frame.taskDigest;
    assert.equal(wsDigest.running_count, 50); assert.equal(wsDigest.total_count, 600); assert.equal(wsDigest.truncated, true); assert.equal(wsDigest.tasks.length, 512);
    await writeFile(join(evidenceDir, 'sessions-activity-frame.json'), JSON.stringify(wsReceipt, null, 2) + '\n');
    item('2', 'sessions.activity carries the exact pre-truncation scalars', true, ['sessions-activity-frame.json'], { runningCount: 50, totalCount: 600, retainedRows: 512, truncated: true });

    const jar = join(fixtureRoot, 'curl.cookies');
    const curlLogin = await command('curl', ['-sS', '-i', '-c', jar, '-H', 'Content-Type: application/json', '--data', '{"password":"exact-counts-isolated"}', url + '/api/login']);
    await writeFile(join(evidenceDir, 'curl-login.txt'), curlLogin.stdout);
    const curlLive = await command('curl', ['-sS', '-i', '-b', jar, url + livePath]);
    await writeFile(join(evidenceDir, 'curl-sessions-live.txt'), curlLive.stdout);
    const splitAt = curlLive.stdout.search(/\r?\n\r?\n/); assert.ok(splitAt >= 0);
    const liveBody = JSON.parse(curlLive.stdout.slice(splitAt).replace(/^\r?\n\r?\n/, ''));
    const liveRow = liveBody.sessions.find(row => row.id === 'qa-counts-chat'); assert.ok(liveRow);
    assert.equal(liveRow.task_digest.running_count, 50); assert.equal(liveRow.task_digest.total_count, 600);
    assert.equal(liveRow.task_digest.truncated, true); assert.equal(liveRow.task_digest.tasks.length, 512);
    item('1', 'authenticated curl -i preserves exact counts with a truncated row list', true, ['curl-login.txt', 'curl-sessions-live.txt'], { runningCount: 50, totalCount: 600, retainedRows: 512, truncated: true });

    await network.wait(rows => rows.filter(row => row.event === 'response' && row.path === livePath && row.status === 200).length >= 3, 'three polling responses', 15_000);
    const closedBoundary = network.rows.length;
    const closedWindow = network.rows.slice(0, closedBoundary);
    const forbiddenClosed = closedWindow.filter(row => row.event === 'request' && (row.path === taskPath || row.path.startsWith(dagPrefix)));
    assert.equal(await page.locator('.th-activity-shelf').getAttribute('data-open'), 'false');
    assert.deepEqual(forbiddenClosed, []);
    await writeFile(join(evidenceDir, 'network-closed-tabs.json'), JSON.stringify(closedWindow, null, 2) + '\n');
    item('3', 'three closed-tab polling cycles issue no roster or DAG reads', true, ['network-closed-tabs.json'], { pollingResponses: closedWindow.filter(row => row.event === 'response' && row.path === livePath && row.status === 200).length, taskRequests: 0, dagRequests: 0 });

    const badge = page.locator('.th-tree-running--workspace');
    await badge.waitFor({ state: 'visible' });
    assert.equal((await badge.textContent())?.trim(), '50');
    const compactMarkers = await page.locator('.th-tree-running, .th-activity-tab-count').allTextContents();
    const partialMarkers = compactMarkers.filter(text => /[?+]/.test(text));
    const badgeShot = join(evidenceDir, 'sidebar-badge-50.png'); await page.screenshot({ path: badgeShot, fullPage: true });
    item('4', 'sidebar badge renders exactly 50 with no question-mark or plus marker anywhere', partialMarkers.length === 0, ['sidebar-badge-50.png'], { badge: '50', compactMarkers, partialMarkers });

    const beforeOpen = network.rows.filter(row => row.event === 'request' && row.path === taskPath).length;
    assert.equal(beforeOpen, 0);
    const taskResponse = network.wait((_, row) => row.event === 'response' && row.path === taskPath && row.status === 200, 'single roster response');
    await page.locator('[data-activity-tab="agents"]').click(); await taskResponse;
    await page.locator('[data-activity-roster-status="ready"]').waitFor({ state: 'attached' });
    const rosterRows = page.locator('[data-activity-tabpanel="agents"] .th-activity-agent');
    const rosterNames = await rosterRows.locator('.th-activity-agent-name').allTextContents();
    const expectedRosterNames = Array.from({ length: 50 }, (_, index) => `(qa-worker) - Running task ${String(index + 1).padStart(3, '0')}`);
    assert.deepEqual(expectedRosterNames.filter(name => !rosterNames.includes(name)), [], 'all 50 authoritative roster rows render');
    const afterOpen = network.rows.filter(row => row.event === 'request' && row.path === taskPath).length;
    assert.equal(afterOpen, 1);
    const openBoundary = network.rows.length;
    await writeFile(join(evidenceDir, 'network-open-agents.json'), JSON.stringify(network.rows.slice(closedBoundary, openBoundary), null, 2) + '\n');
    await page.screenshot({ path: join(evidenceDir, 'agents-full-roster-50.png'), fullPage: true });
    item('5', 'opening Subagents fires exactly one full-roster read and renders all 50 authoritative rows', true, ['network-open-agents.json', 'agents-full-roster-50.png'], { taskRequests: 1, authoritativeRosterRows: 50, renderedRowsIncludingDigestHistory: await rosterRows.count() });

    await page.locator('[data-activity-tab="agents"]').click();
    await page.locator('.th-activity-shelf[data-open="false"]').waitFor({ state: 'attached' });
    const pollsAtClose = network.rows.filter(row => row.event === 'response' && row.path === livePath && row.status === 200).length;
    await network.wait(rows => rows.filter(row => row.event === 'response' && row.path === livePath && row.status === 200).length >= pollsAtClose + 2, 'two post-close polling responses', 12_000);
    const postClose = network.rows.slice(openBoundary);
    assert.equal(network.rows.filter(row => row.event === 'request' && row.path === taskPath).length, 1);
    await writeFile(join(evidenceDir, 'network-after-close.json'), JSON.stringify(postClose, null, 2) + '\n');
    item('6', 'closing Subagents stops full-roster reads while scalar polling continues', true, ['network-after-close.json'], { totalTaskRequests: 1, additionalTaskRequests: 0, additionalPollingResponses: network.rows.filter(row => row.event === 'response' && row.path === livePath && row.status === 200).length - pollsAtClose });

    await writeFile(join(evidenceDir, 'browser-network.json'), JSON.stringify(network.rows, null, 2) + '\n');
    await writeFile(join(evidenceDir, 'browser-websocket.json'), JSON.stringify(wire.rows, null, 2) + '\n');
    const fixtureReceipt = await (await context.request.get(url + '/__qa/receipt')).json();
    await writeFile(join(evidenceDir, 'fixture-traffic.json'), JSON.stringify(fixtureReceipt, null, 2) + '\n');
    report.artifacts = { network: 'browser-network.json', websocket: 'browser-websocket.json', fixtureTraffic: 'fixture-traffic.json', fixtureBuild: 'fixture-build.log' };
    report.status = 'PASS';
  } catch (error) {
    failure = error; report.errors.push({ message: error.message, stack: error.stack });
    if (page && !page.isClosed()) { try { await page.screenshot({ path: join(evidenceDir, 'failure.png'), fullPage: true }); report.artifacts.failureScreenshot = 'failure.png'; } catch {} }
  } finally {
    if (context) { try { await context.close(); report.cleanup.browserContextClosed = true; } catch (error) { report.cleanup.browserContextClosed = false; report.errors.push({ cleanup: 'browser', error: String(error) }); } }
    if (profile) { try { await rm(profile, { recursive: true, force: true }); report.cleanup.browserProfileRemoved = !(await exists(profile)); } catch (error) { report.cleanup.browserProfileRemoved = false; report.errors.push({ cleanup: 'profile', error: String(error) }); } }
    if (child) {
      try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); const result = await deadline(childExit, 'fixture shutdown', 12_000); report.cleanup.fixtureProcess = { pid: child.pid, ...result, exited: true }; } catch (error) { child.kill('SIGKILL'); report.cleanup.fixtureProcess = { pid: child.pid, exited: false, error: String(error) }; report.errors.push({ cleanup: 'fixtureProcess', error: String(error) }); }
    }
    if (url) { try { report.cleanup.portReleased = await portReleased(Number(new URL(url).port)); } catch (error) { report.cleanup.portReleased = false; report.errors.push({ cleanup: 'port', error: String(error) }); } }
    await writeFile(join(evidenceDir, 'fixture-stdout.log'), stdout); await writeFile(join(evidenceDir, 'fixture-stderr.log'), stderr);
    if (fixtureRoot) { try { await rm(fixtureRoot, { recursive: true, force: true }); report.cleanup.fixtureRootRemoved = !(await exists(fixtureRoot)); } catch (error) { report.cleanup.fixtureRootRemoved = false; report.errors.push({ cleanup: 'fixtureRoot', error: String(error) }); } }
    report.finishedAt = new Date().toISOString();
    const cleanupPassed = report.cleanup.browserContextClosed === true && report.cleanup.browserProfileRemoved === true && report.cleanup.fixtureProcess?.exited === true && report.cleanup.portReleased === true && report.cleanup.fixtureRootRemoved === true;
    if (!cleanupPassed || report.errors.length > 0 || report.items.length !== 6 || report.items.some(row => row.status !== 'PASS')) report.status = 'FAIL';
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
