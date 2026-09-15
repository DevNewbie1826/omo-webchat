// Live sidebar card-height QA (RED capture against unchanged product code).
//
// Builds the SPA, builds+starts the lean fixture (which embeds the just-built
// dist), logs in through the real cookie flow, loads the SPA in REAL Google
// Chrome via playwright-core (isolated mkdtemp profile - never a real user
// profile), waits for the four fixture live cards, and measures
// getBoundingClientRect().height of every .th-sidebar-live-list
// .th-overview-card plus meta presence. The card with no work at all
// ("Idle attached") loses the conditional meta line and renders shorter:
// that heightSpread > 0 is the RED evidence for the uniform-height fix.
//
// status is PASS only when cardCount === 4 && heightSpread === 0 &&
// metaCount === 0; a FAIL status is a valid, expected result, so the process
// exits 0 whenever the measurement itself completed and non-zero only when it
// could not run. The script never gates on a clean git tree or a pushed head.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';

const repo = resolve(import.meta.dirname, '../..');
const frontendDir = join(repo, 'frontend');
const driverPath = process.env.QA_PLAYWRIGHT ?? join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs');
const chromePath = process.env.QA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const password = 'live-card-height-qa';
const runFile = 'qa-run.json';
const chromeMarker = 'live-card-height-chrome-';
const viewport = { width: 1440, height: 900 };
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

function deadline(promise, label, ms = 30_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline`)), ms); })])
    .finally(() => clearTimeout(timer));
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
  evidenceDir = resolve(evidenceDir);
  await mkdir(evidenceDir, { recursive: true });
  const report = {
    status: 'BLOCKED', task: 'live-card-height', viewport, startedAt: new Date().toISOString(),
    cardCount: null, heights: [], heightSpread: null, metaCount: null, cards: [], screenshots: [], cleanup: {}, errors: [],
  };
  let fixtureRoot, profile, child, childExit, url, context, page;
  let stdout = '', stderr = '';
  let measured = false;
  try {
    // 1. Build the SPA first: the fixture go build below embeds frontend/dist,
    //    so the measured bytes always match the current source tree.
    const build = await command('npm', ['run', 'build'], { cwd: frontendDir, maxBuffer: 32 * 1024 * 1024, timeout: 300_000 });
    await writeFile(join(evidenceDir, 'build.log'), build.stdout + build.stderr);

    // 2. Build the fixture (embeds the fresh dist) in an owned temp root.
    fixtureRoot = await mkdtemp(join(tmpdir(), 'live-card-height-fixture-'));
    const binary = join(fixtureRoot, 'fixture');
    const fixtureBuild = await command('go', ['build', '-o', binary, 'test/qa/live-card-height-fixture.go'], { cwd: repo, timeout: 240_000 });
    await writeFile(join(evidenceDir, 'fixture-build.log'), fixtureBuild.stdout + fixtureBuild.stderr);

    // 3. Start the fixture and wait for its readiness line.
    await mkdir(join(fixtureRoot, 'state'));
    child = spawn(binary, ['--root', join(fixtureRoot, 'state'), '--listen', '127.0.0.1:0'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    childExit = new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolveExit({ code, signal })); });
    const ready = new Promise((resolveReady, reject) => {
      child.stdout.on('data', chunk => { stdout += chunk; const found = /LIVE_CARD_QA_READY (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout); if (found) resolveReady(found[1]); });
      child.stderr.on('data', chunk => { stderr += chunk; });
      childExit.then(result => reject(new Error(`fixture exited before readiness: ${JSON.stringify(result)} ${stderr}`)));
    });
    url = await deadline(ready, 'fixture readiness', 30_000);
    report.fixtureUrl = url;

    // 4. Real Chrome through playwright-core, isolated mkdtemp profile.
    profile = await mkdtemp(join(tmpdir(), chromeMarker));
    const { chromium } = await import(pathToFileURL(driverPath).href);
    context = await chromium.launchPersistentContext(profile, {
      executablePath: chromePath, headless: true, viewport, reducedMotion: 'reduce', timeout: 30_000,
    });
    await context.addInitScript(() => { localStorage.setItem('th-lang', 'en'); });
    context.setDefaultTimeout(20_000);
    page = context.pages()[0];

    // 5. Log in through the real cookie flow, then boot the SPA.
    const login = await context.request.post(url + '/api/login', { data: { password } });
    if (login.status() !== 200) throw new Error(`login failed: ${login.status()} ${await login.text()}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // 6. Wait until the sidebar live list renders exactly the four fixture cards.
    await page.waitForFunction(
      () => document.querySelectorAll('.th-sidebar-live-list .th-overview-card').length === 4,
      null,
      { timeout: 30_000, polling: 250 },
    );

    // 7. Measure every card: height, title, meta presence, meta text.
    const cards = await page.evaluate(() =>
      [...document.querySelectorAll('.th-sidebar-live-list .th-overview-card')].map(card => {
        const meta = card.querySelector('.th-overview-card-meta');
        const rect = card.getBoundingClientRect();
        return {
          height: Math.round(rect.height * 100) / 100,
          title: (card.querySelector('.th-overview-card-name')?.textContent ?? '').trim(),
          hasMeta: meta !== null,
          metaText: meta !== null ? (meta.textContent ?? '').replace(/\s+/g, ' ').trim() : null,
        };
      }),
    );
    const heights = cards.map(card => card.height);
    const heightSpread = heights.length > 0 ? Math.round((Math.max(...heights) - Math.min(...heights)) * 100) / 100 : null;
    const metaCount = cards.filter(card => card.hasMeta).length;
    report.cardCount = cards.length;
    report.cards = cards;
    report.heights = heights;
    report.heightSpread = heightSpread;
    report.metaCount = metaCount;
    measured = true;

    // 8. Screenshot the sidebar live region and the full page.
    await page.locator('.th-sidebar-live').screenshot({ path: join(evidenceDir, 'sidebar-live.png') });
    await page.screenshot({ path: join(evidenceDir, 'full-page.png'), fullPage: true });
    report.screenshots = ['sidebar-live.png', 'full-page.png'];

    report.status = report.cardCount === 4 && report.heightSpread === 0 && report.metaCount === 0 ? 'PASS' : 'FAIL';
  } catch (error) {
    report.errors.push({ message: error.message, stack: error.stack });
    if (!measured) report.status = 'BLOCKED';
    else report.status = 'FAIL';
    if (page && !page.isClosed()) { try { await page.screenshot({ path: join(evidenceDir, 'failure.png'), fullPage: true }); report.screenshots = [...report.screenshots, 'failure.png']; } catch {} }
  } finally {
    if (context) { try { await context.close(); report.cleanup.browserContextClosed = true; } catch (error) { report.cleanup.browserContextClosed = false; report.errors.push({ cleanup: 'browser', error: String(error) }); } }
    try { report.cleanup.chromeSweep = await sweepChromeProcesses(chromeMarker); } catch (error) { report.cleanup.chromeSweep = { swept: false, error: String(error) }; report.errors.push({ cleanup: 'chromeSweep', error: String(error) }); }
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
    await writeFile(join(evidenceDir, 'fixture-stdout.log'), stdout);
    await writeFile(join(evidenceDir, 'fixture-stderr.log'), stderr);
    if (fixtureRoot) { try { await rm(fixtureRoot, { recursive: true, force: true }); report.cleanup.fixtureRootRemoved = !(await exists(fixtureRoot)); } catch (error) { report.cleanup.fixtureRootRemoved = false; report.errors.push({ cleanup: 'fixtureRoot', error: String(error) }); } }
    report.cleanup.receipt = [
      `browser context ${report.cleanup.browserContextClosed === true ? 'closed' : 'NOT CLOSED'}`,
      `chrome swept by marker ${chromeMarker} (${report.cleanup.chromeSweep?.error !== undefined ? 'error' : report.cleanup.chromeSweep?.swept === true ? 'no leftovers' : `leftover ${JSON.stringify(report.cleanup.chromeSweep?.leftover ?? [])}`})`,
      `profile ${report.cleanup.browserProfileRemoved === true ? 'removed' : 'REMAINS'}`,
      `fixture pid ${child?.pid ?? 'n/a'} ${report.cleanup.fixtureProcess?.exited === true ? `exited (${JSON.stringify({ code: report.cleanup.fixtureProcess.code, signal: report.cleanup.fixtureProcess.signal })}, kill0=${report.cleanup.fixtureProcess.kill0})` : 'NOT CONFIRMED EXITED'}`,
      `port ${url ? `${new URL(url).port} ${report.cleanup.portReleased === true ? 'released' : 'STILL HELD'}` : 'n/a'}`,
      `fixture root ${report.cleanup.fixtureRootRemoved === true ? 'removed' : 'REMAINS'}`,
    ].join('; ');
    report.finishedAt = new Date().toISOString();
    await writeFile(join(evidenceDir, runFile), JSON.stringify(report, null, 2) + '\n');
    console.log(`CLEANUP RECEIPT: ${report.cleanup.receipt}`);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const evidence = process.argv[2];
  if (!evidence) { console.error('usage: bun test/qa/live-card-height.mjs EVIDENCE_DIR'); process.exit(2); }
  try {
    const report = await run(evidence);
    console.log(JSON.stringify({ status: report.status, cardCount: report.cardCount, heights: report.heights, heightSpread: report.heightSpread, metaCount: report.metaCount }));
    process.exitCode = report.status === 'BLOCKED' ? 1 : 0; // FAIL is a valid measured result
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
  }
}

export { run };
