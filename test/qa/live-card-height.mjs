// Live sidebar card-height QA (resting uniformity + activation states + RED baseline comparison).
//
// Builds the SPA, builds+starts the lean fixture (which embeds the just-built
// dist and serves the session-catalog + per-session open endpoints), logs in
// through the real cookie flow, loads the SPA in a real Chromium-family
// browser via playwright-core (isolated mkdtemp profile - never a real user
// profile), then measures three things:
//
//   resting    - getBoundingClientRect().height of every .th-sidebar-live-list
//                .th-overview-card plus meta presence; all four must match
//                exactly (spread 0) and no card may render the old meta line;
//   activation - one activation state per page load: before each click the
//                page is reloaded back to the resting list (asserted: every
//                card at its resting height, no status row anywhere), then a
//                card is clicked into "opening" (slow open response),
//                "already active elsewhere" (409 conflict) or "open failed"
//                (error response) through the fixture's runtime-swappable
//                open map (POST /api/qa/open-map; exactly one session carries
//                a behavior at a time, swapped before each step's reload, so
//                the SAME session can be driven into different states on
//                different fresh page loads while the rendered four-card
//                list never changes shape - a fifth card would overflow the
//                section's max-height and flex-shrink every card onto its
//                min-height floor, crushing the transient status rows the
//                gate must measure). The
//                observer armed before the click resolves only when the
//                status label EXACTLY equals the step's expected final text
//                (the row first appears as "Opening…" and is swapped a beat
//                later), measurement runs after two animation-frame ticks
//                with each card's rect width recorded alongside its height
//                and the scrollport's clientWidth/scrollHeight captured per
//                step; the activated card's own status-row rect and text
//                are read in the SAME evaluate call that measures the
//                cards, and each step's screenshot is taken in that
//                settled state and immediately re-checked - the row must
//                still be on screen when the pixels are captured; the
//                activated height must be STRICTLY greater than the same
//                step's preClick resting height or the run FAILs
//                (non-vacuousness - a vacuous step never reaches the
//                same-state gate); heights are only compared between steps whose
//                measured width is identical. Every step asserts that the
//                cards WITHOUT a status row still measure the resting
//                height. The transient status row making its own card taller
//                is the expected product behavior. Same-state height
//                equality across different sessions is a REQUIRED PASS
//                condition: two cards driven into the same activation state
//                at identical measured widths must differ by no more than
//                the declared sub-pixel tolerance (HEIGHT_TOLERANCE, also
//                recorded in the report) or the run FAILs. Two same-state
//                pairs are exercised: "opening" on a count-badge card and
//                on a badge-free card, plus the "session-active" pair;
//   comparison - every resting height must be strictly greater than the RED
//                baseline's title-only height (the old "Idle attached" card).
//
// All page-side waits are pre-armed event subscriptions installed by the init
// script BEFORE the DOM-changing action runs: a MutationObserver per signal
// (boot readiness, per-card activation label) plus a requestAnimationFrame
// settle check that resolves only once every card height is identical across
// consecutive frames, so measurements never catch a mid-relayout frame. No
// fixed-interval checks anywhere.
//
// Machine independence: the playwright-core entry and the browser executable
// are NEVER defaulted. QA_PLAYWRIGHT (absolute path or module specifier of
// the playwright-core entry) and QA_CHROME (browser executable path) must
// both be set and must exist; otherwise the script exits non-zero before
// doing any work, with a message naming both variables.
//
// status is PASS only when cardCount === 4 && heightSpread === 0 &&
// metaCount === 0 && every resting height strictly exceeds the RED
// title-only height && in every activation step the cards WITHOUT a status
// row still measure the resting height && every same-state pair measures
// equal heights at identical widths && every activated card is strictly
// taller than its own preClick resting height && every step screenshot was
// taken with the status row still on screen. A FAIL status is a valid,
// expected
// result, so the
// process exits 0 whenever the measurement itself completed and non-zero
// only when it could not run. The script never gates on a clean git tree or
// a pushed head.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';

const repo = resolve(import.meta.dirname, '../..');
const frontendDir = join(repo, 'frontend');
const password = 'live-card-height-qa';
const runFile = 'qa-run.json';
const chromeMarker = 'live-card-height-chrome-';
const viewport = { width: 1440, height: 900 };
const redBaselinePath = '.omo/qa/live-card-height/red/qa-run.json';
// Must match the fixture's single catalog workspace: the init script
// pre-expands it so the session catalog load is part of the boot path.
const fixtureWorkspaceId = 'ws-live-qa';
// Card activation plan: state names are the SPA's open-attempt statuses;
// fixtureBehavior is the behavior the runtime open map serves for that
// step's session. Two states are each driven on TWO sessions so the
// required same-state height gate has real comparison pairs: "opening" on
// a count-badge card ("Refactor auth") and on the badge-free card ("Quiet
// session"), and "session-active" on a count-badge card ("Docs sweep")
// and the dot-only active card ("Idle attached"). "Quiet session" is also
// the failed step - legal because every step runs on a fresh page load with
// its own swapped-in behavior. Titles come from the fixture's live rows;
// cards are matched by title, never by DOM order.
const stateLabels = { opening: 'Opening…', 'session-active': 'Read-only live view', failed: 'Open failed' };
// Sub-pixel tolerance for height equality: device-pixel rounding can differ by
// a hundredth of a CSS pixel between structurally identical cards (observed
// 44.7 vs 44.69 for the same state), which is not a product defect.
const HEIGHT_TOLERANCE = 0.05;
const sameHeight = (a, b) => Math.abs(a - b) <= HEIGHT_TOLERANCE;
const activationPlan = [
  { state: 'opening', fixtureBehavior: 'slow', session: 's-agents-dag', title: 'Refactor auth' },
  { state: 'opening', fixtureBehavior: 'slow', session: 's-done-only', title: 'Quiet session' },
  { state: 'session-active', fixtureBehavior: 'conflict', session: 's-agents-only', title: 'Docs sweep' },
  { state: 'session-active', fixtureBehavior: 'conflict', session: 's-main-only', title: 'Idle attached' },
  { state: 'failed', fixtureBehavior: 'error', session: 's-done-only', title: 'Quiet session' },
];
// Required same-state gate: for every activation state driven on two
// sessions, the two cards must measure the same height when measured at the
// same width. Width identity and height equality both allow the declared
// sub-pixel tolerance, because device-pixel rounding can differ by a
// hundredth of a CSS pixel between structurally identical cards; anything
// beyond it is a product defect. A pair whose widths differ beyond the
// tolerance is NOT comparable - the gate cannot verify the invariant, so it
// fails the run instead of silently voiding it. Pure, so the gate can be
// exercised directly against fabricated measurements (the QA log records a
// 10px mismatch failing the run).
const evaluateSameStateGate = (steps, tolerance = HEIGHT_TOLERANCE) => {
  const groups = new Map();
  for (const step of steps) {
    const list = groups.get(step.state) ?? [];
    list.push(step);
    groups.set(step.state, list);
  }
  const pairs = [];
  for (const [state, list] of groups) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i], b = list[j];
        const widthDelta = Math.round(Math.abs(a.width - b.width) * 100) / 100;
        const heightsComparable = widthDelta <= tolerance;
        const heightDelta = Math.round(Math.abs(a.height - b.height) * 100) / 100;
        const equal = heightsComparable ? heightDelta <= tolerance : null;
        pairs.push({
          state,
          a: { title: a.title, height: a.height, width: a.width },
          b: { title: b.title, height: b.height, width: b.width },
          widthDelta, heightsComparable, heightDelta, equal,
          gate: heightsComparable ? equal === true : false,
          note: heightsComparable
            ? (equal === true ? 'same state, identical widths, heights equal within tolerance' : 'same state at identical widths but heights differ beyond tolerance')
            : 'widths differ beyond tolerance - heights not comparable, gate unverifiable',
        });
      }
    }
  }
  return {
    required: true, tolerance, pairs,
    pass: pairs.length > 0 && pairs.every(pair => pair.gate === true),
  };
};
// The PASS gate, exactly: four resting cards at spread 0 with no meta line,
// every resting height strictly greater than the RED title-only height,
// every activation step leaving non-activated cards at their resting
// height, every same-state pair equal at identical widths, every activated
// card strictly taller than its own preClick resting height (a step whose
// activated height equals rest is a vacuous measurement and FAILs the run),
// and every step screenshot taken with the status row still on screen.
// Pure, so a fabricated report (e.g. a 10px same-state mismatch, or a step
// that did not grow) can be shown to return FAIL without a browser.
const computeStatus = (report) => report.cardCount === 4
  && report.heightSpread === 0
  && report.metaCount === 0
  && report.comparison?.everyRestingHeightExceedsRedTitleOnly === true
  && report.activation?.othersKeepRestingHeight === true
  && report.activation?.activatedCardsGrew === true
  && report.activation?.screenshotsShowStateRows === true
  && report.activation?.sameStateGate?.pass === true
  ? 'PASS' : 'FAIL';
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

// Select every process whose command line references THIS run's exact
// profile path. The mkdtemp suffix is unique per run, so a concurrent QA
// run's browser - same shared PREFIX, different profile directory - is
// never selected. The ps command column is matched as a literal substring,
// never as a regex and never by the shared prefix alone.
async function selectProfileProcesses(profilePath) {
  const { stdout } = await command('ps', ['-axo', 'pid=,command=']);
  const selected = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match === null || !line.includes(profilePath)) continue;
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && pid > 0) selected.push({ pid, command: match[2] });
  }
  return selected;
}

// Sweep any browser process still holding THIS run's isolated temp profile
// (matched by this run's unique mkdtemp path) and confirm reaping via
// kill -0. Scoped to this run only: it can no longer signal a concurrent
// independent QA run's browser that merely shares the marker prefix.
async function sweepChromeProcesses(profilePath) {
  const selected = await selectProfileProcesses(profilePath);
  const pids = selected.map(entry => entry.pid);
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  const leftover = [];
  for (const pid of pids) {
    if (await waitPidExit(pid, 5_000)) continue;
    try { process.kill(pid, 'SIGKILL'); } catch {}
    if (!(await waitPidExit(pid, 3_000))) leftover.push(pid);
  }
  return { scope: "this run's profile path", marker: profilePath, selectedPids: pids, swept: leftover.length === 0, leftover };
}

// Prove the sweep's ownership scoping with a live decoy: a process whose
// command line carries the same shared mkdtemp PREFIX as this run's browser
// but a different (another run's) profile path. The decoy is spawned before
// the browser session starts, so the process table is long settled by the
// time this proof reads it. The profile-scoped sweep must never select it;
// this function verifies that live, then reaps the decoy it owns.
async function proveSweepOwnership({ decoy, decoyProfile, profile }) {
  const { stdout } = await command('ps', ['-axo', 'pid=,command=']);
  const decoyPattern = new RegExp(`^\\s*${decoy.pid}\\s+`);
  const decoyLine = stdout.split('\n').find(line => decoyPattern.test(line) && line.includes(decoyProfile));
  const selected = await selectProfileProcesses(profile);
  const decoySelected = selected.some(entry => entry.pid === decoy.pid);
  let decoyAliveAfterSweep = false;
  try { process.kill(decoy.pid, 0); decoyAliveAfterSweep = true; } catch {}
  let decoyTerminated = false;
  try { decoy.kill('SIGTERM'); } catch {}
  decoyTerminated = await waitPidExit(decoy.pid, 5_000);
  return {
    sharedPrefix: chromeMarker,
    thisRunProfile: profile,
    otherRunProfile: decoyProfile,
    decoyPid: decoy.pid,
    decoyCommandCarriesSharedPrefix: decoyLine !== undefined,
    decoySelected,
    decoyAliveAfterSweep,
    decoyTerminated,
    proven: decoyLine !== undefined && decoySelected === false && decoyAliveAfterSweep === true,
  };
}

// The harness owns no machine-specific defaults: both the playwright-core
// entry and the browser executable MUST come from the environment, and the
// error message always names both variables so a missing piece is obvious.
async function validateEnvironment() {
  const problems = [];
  const playwrightValue = (process.env.QA_PLAYWRIGHT ?? '').trim();
  const chromeValue = (process.env.QA_CHROME ?? '').trim();
  if (playwrightValue === '') problems.push('QA_PLAYWRIGHT is not set');
  else if (playwrightValue.startsWith('/') && !(await exists(playwrightValue))) problems.push(`QA_PLAYWRIGHT path does not exist: ${playwrightValue}`);
  if (chromeValue === '') problems.push('QA_CHROME is not set');
  else if (!chromeValue.startsWith('/')) problems.push(`QA_CHROME must be an absolute path to the browser executable: ${chromeValue}`);
  else if (!(await exists(chromeValue))) problems.push(`QA_CHROME executable does not exist: ${chromeValue}`);
  if (problems.length > 0) {
    throw new Error([
      'QA harness environment incomplete - both variables are required:',
      '  QA_PLAYWRIGHT = absolute path or module specifier of the playwright-core entry',
      '  QA_CHROME     = absolute path of the browser executable',
      ...problems.map(problem => `  - ${problem}`),
    ].join('\n'));
  }
  return { playwright: playwrightValue, chrome: chromeValue };
}

async function importDriver(specifier) {
  try {
    return specifier.startsWith('/') ? await import(pathToFileURL(specifier).href) : await import(specifier);
  } catch (error) {
    throw new Error(`QA_PLAYWRIGHT could not be imported (${specifier}). Set QA_PLAYWRIGHT to an existing playwright-core entry (absolute path or module specifier) and QA_CHROME to the browser executable. Cause: ${error?.message ?? error}`);
  }
}

async function run(evidenceDir) {
  const environment = await validateEnvironment();
  evidenceDir = resolve(evidenceDir);
  await mkdir(evidenceDir, { recursive: true });
  const report = {
    status: 'BLOCKED', task: 'live-card-height', viewport, startedAt: new Date().toISOString(),
    cardCount: null, heights: [], heightSpread: null, metaCount: null, cards: [],
    restingFreeOfStateRows: null, activation: null, comparison: null,
    screenshots: [], cleanup: {}, errors: [],
  };
  let fixtureRoot, profile, decoy, decoyProfile, child, childExit, url, context, page;
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

    // 3. Start the fixture with the per-session open behaviors the activation
    //    stage drives, and wait for its readiness line.
    await mkdir(join(fixtureRoot, 'state'));
    child = spawn(binary, [
      '--root', join(fixtureRoot, 'state'), '--listen', '127.0.0.1:0',
    ], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    childExit = new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolveExit({ code, signal })); });
    const ready = new Promise((resolveReady, reject) => {
      child.stdout.on('data', chunk => { stdout += chunk; const found = /LIVE_CARD_QA_READY (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout); if (found) resolveReady(found[1]); });
      child.stderr.on('data', chunk => { stderr += chunk; });
      childExit.then(result => reject(new Error(`fixture exited before readiness: ${JSON.stringify(result)} ${stderr}`)));
    });
    url = await deadline(ready, 'fixture readiness', 30_000);
    report.fixtureUrl = url;

    // 4. Real browser through playwright-core, isolated mkdtemp profile. The
    //    init script arms every page-side wait BEFORE the SPA boots: the
    //    four-card signal, the session-catalog signal (cards become openable
    //    once picker/tree rows exist), and the per-card activation helper
    //    whose MutationObserver is armed before its triggering click.
    profile = await mkdtemp(join(tmpdir(), chromeMarker));
    // Ownership-scoping decoy: a stand-in for a CONCURRENT independent QA
    // run's browser - same shared mkdtemp PREFIX in its command line, but a
    // different profile path. The cleanup sweep selects by this run's exact
    // profile path, so it must never touch the decoy; proveSweepOwnership
    // verifies that live at cleanup time and reaps the decoy. Spawned here,
    // before the browser session, so the process table is long settled by
    // the time the proof reads it. The no-op error handler keeps a failed
    // spawn from crashing the run; the proof would then report not-proven.
    decoyProfile = join(dirname(profile), `${chromeMarker}other-run-${Math.random().toString(36).slice(2, 8)}`);
    decoy = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 600000)', `user-data-dir=${decoyProfile}`], { stdio: 'ignore' });
    decoy.once('error', () => {});
    const { chromium } = await importDriver(environment.playwright);
    context = await chromium.launchPersistentContext(profile, {
      executablePath: environment.chrome, headless: true, viewport, reducedMotion: 'reduce', timeout: 30_000,
    });
    await context.addInitScript(`
      localStorage.setItem('th-lang', 'en');
      localStorage.setItem('th-ws-expanded', JSON.stringify(['${fixtureWorkspaceId}']));
      const liveCardSelector = '.th-sidebar-live-list .th-overview-card';
      const armSignal = (predicate) => new Promise((resolve) => {
        if (predicate()) { resolve(true); return; }
        const observer = new MutationObserver(() => { if (predicate()) { observer.disconnect(); resolve(true); } });
        const start = () => observer.observe(document.documentElement, { childList: true, subtree: true });
        if (document.documentElement) start();
        else document.addEventListener('readystatechange', () => { if (document.documentElement) start(); }, { once: true });
      });
      window.__qaLiveCardsReady = armSignal(() => document.querySelectorAll(liveCardSelector).length >= 4);
      window.__qaSessionCatalogReady = armSignal(() => document.querySelector('.th-picker-pane-item, .th-tree-node .th-tree-placed') !== null);
      // Frame-settled heights: resolves only after consecutive animation
      // frames produce identical height vectors, so a measurement can never
      // land on a transient mid-relayout frame.
      window.__qaSettledHeights = () => new Promise((resolve, reject) => {
        const read = () => [...document.querySelectorAll(liveCardSelector)].map(card => Math.round(card.getBoundingClientRect().height * 1000) / 1000);
        let previous = read();
        let stable = 0;
        let frames = 0;
        const tick = () => {
          const current = read();
          stable = JSON.stringify(current) === JSON.stringify(previous) ? stable + 1 : 0;
          previous = current;
          if (stable >= 2) { resolve(current); return; }
          if (++frames > 90) { reject(new Error('card heights did not settle across animation frames')); return; }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      // Two animation-frame ticks: the prescribed post-signal layout-settle
      // wait. Frames are vsync events - no timers involved.
      window.__qaTwoFrames = () => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
      // Activation helper: arms the state-row observer BEFORE the click that
      // makes React insert it. The signal resolves only when the row's status
      // label EXACTLY equals the expected final label for the step
      // ("Opening…", "Read-only live view" or "Open failed") - never at bare
      // row insertion, because the 409/500 response swaps the label a beat
      // after the row first appears as "Opening…".
      window.__qaActivateLiveCard = (title, label) => {
        const cards = [...document.querySelectorAll(liveCardSelector)];
        const card = cards.find(candidate => (candidate.querySelector('.th-overview-card-name')?.textContent ?? '').trim() === title);
        if (card === undefined) return { armed: false, reason: 'no live card titled ' + JSON.stringify(title) + ' among [' + cards.map(candidate => (candidate.querySelector('.th-overview-card-name')?.textContent ?? '').trim()).join(', ') + ']' };
        if (card.querySelector('.th-overview-card-state') !== null) return { armed: false, reason: 'card ' + JSON.stringify(title) + ' already shows an activation state row' };
        const button = card.querySelector('.th-overview-card-open');
        if (button === null || button.disabled) return { armed: false, reason: 'card ' + JSON.stringify(title) + ' has no enabled open button' };
        const statusLabel = (row) => (row.querySelector('span')?.textContent ?? '').trim();
        const signal = new Promise((resolve) => {
          const observer = new MutationObserver(() => {
            const row = card.querySelector('.th-overview-card-state');
            if (row !== null && statusLabel(row) === label) {
              observer.disconnect();
              resolve(statusLabel(row));
            }
          });
          observer.observe(card, { childList: true, subtree: true, characterData: true });
        });
        button.click(); // the DOM-changing action runs strictly after the observer above is armed
        return { armed: true, signal };
      };
    `);
    context.setDefaultTimeout(20_000);
    page = context.pages()[0];

    // 5. Log in through the real cookie flow, then boot the SPA.
    const login = await context.request.post(url + '/api/login', { data: { password } });
    if (login.status() !== 200) throw new Error(`login failed: ${login.status()} ${await login.text()}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // 6. Await the init-armed signals under bounded deadlines: exactly four
    //    live cards, then the session catalog that makes them openable.
    await deadline(page.evaluate(() => {
      if (typeof window.__qaLiveCardsReady === 'undefined') throw new Error('live-card boot signal missing: init script did not run');
      return window.__qaLiveCardsReady;
    }), 'four live cards', 30_000);
    await deadline(page.evaluate(() => {
      if (typeof window.__qaSessionCatalogReady === 'undefined') throw new Error('session-catalog boot signal missing: init script did not run');
      return window.__qaSessionCatalogReady;
    }), 'session catalog rows (picker/tree)', 30_000);

    // 7. Resting measurement, taken only after the frame-settle signal: height,
    //    width, title, meta presence, meta text, the scrollport's
    //    clientWidth/scrollHeight, and that no card carries an activation
    //    state row at rest.
    const measureLiveList = () => page.evaluate(() => {
      const cards = [...document.querySelectorAll('.th-sidebar-live-list .th-overview-card')].map(card => {
        const meta = card.querySelector('.th-overview-card-meta');
        const state = card.querySelector('.th-overview-card-state');
        const rect = card.getBoundingClientRect();
        return {
          height: Math.round(rect.height * 100) / 100,
          width: Math.round(rect.width * 100) / 100,
          title: (card.querySelector('.th-overview-card-name')?.textContent ?? '').trim(),
          hasMeta: meta !== null,
          metaText: meta !== null ? (meta.textContent ?? '').replace(/\s+/g, ' ').trim() : null,
          stateRow: state !== null,
          statusText: state !== null ? (state.querySelector('span')?.textContent ?? '').trim() : null,
        };
      });
      const port = document.querySelector('.th-sidebar-live');
      const scrollport = port === null ? null : { clientWidth: port.clientWidth, scrollHeight: port.scrollHeight };
      return { cards, scrollport };
    });
    await deadline(page.evaluate(() => window.__qaSettledHeights()), 'resting height settle', 30_000);
    const resting = await measureLiveList();
    const restingCards = resting.cards;
    const restingHeights = restingCards.map(card => card.height);
    const heightSpread = restingHeights.length > 0 ? Math.round((Math.max(...restingHeights) - Math.min(...restingHeights)) * 100) / 100 : null;
    const metaCount = restingCards.filter(card => card.hasMeta).length;
    report.cardCount = restingCards.length;
    report.cards = restingCards;
    report.restingScrollport = resting.scrollport;
    report.heights = restingHeights;
    report.heightSpread = heightSpread;
    report.metaCount = metaCount;
    report.restingFreeOfStateRows = restingCards.every(card => card.stateRow === false);
    measured = true;

    // 8. Resting screenshots (sidebar live region and full page).
    await page.locator('.th-sidebar-live').screenshot({ path: join(evidenceDir, 'sidebar-live.png') });
    await page.screenshot({ path: join(evidenceDir, 'full-page.png'), fullPage: true });
    report.screenshots = ['sidebar-live.png', 'full-page.png'];

    // 9. Activation stage: EXACTLY ONE activation state per FRESH page load.
    //    Before every click the page is reloaded so the list returns to its
    //    resting state (the open-attempt state lives in React and dies with
    //    the document), and the harness ASSERTS that precondition: every card
    //    at its resting height and no .th-overview-card-state anywhere - a
    //    violation throws, because the step could not be measured faithfully.
    //    One grown card at a time also keeps the bounded scrollport
    //    (.th-sidebar-live, max-height min(30vh,216px), overflow-y auto) in
    //    one overflow state per step; the scrollport is a real product
    //    surface, its scrollbar-driven rewrapping is expected behavior, and
    //    every step therefore records each card's rect width plus the
    //    scrollport's clientWidth/scrollHeight. Heights are only compared
    //    between steps whose measured width is identical. Per click: the
    //    observer armed BEFORE the click resolves when the status label
    //    EXACTLY equals the step's expected final label (the row first
    //    appears as "Opening…" and is swapped a beat later), then measurement
    //    runs after two animation-frame ticks (vsync events, no timers), then
    //    a screenshot, then the reload for the next step. Gate-relevant
    //    invariant: every card WITHOUT a status row still measures the
    //    resting height. Same-state height equality across different sessions
    //    is a REQUIRED PASS condition (see evaluateSameStateGate); a pair is
    //    only comparable at identical measured widths, and an incomparable
    //    pair fails the gate. The transient status row making its own card
    //    taller is the expected product behavior under test.
    const restingHeightByTitle = new Map(restingCards.map(card => [card.title, card.height]));
    const activation = {
      plan: activationPlan, stateLabels, heightTolerance: HEIGHT_TOLERANCE, steps: [], sameStateGate: null,
      preClickRestingAsserted: true, labelsMatchExpected: true, othersKeepRestingHeight: true, invariantsHold: false,
      activatedCardsGrew: null, screenshotsShowStateRows: null,
    };
    report.activation = activation;
    const stepRecords = []; // {state, title, height, width} per isolated step
    for (const [stepIndex, planned] of activationPlan.entries()) {
      // 9a-0. Swap the fixture's open map to EXACTLY this step's session and
      //       behavior before anything else: the map replacement (not a
      //       merge) guarantees only the step's target session has a
      //       behavior, and the swap is recorded per step so the report
      //       shows which served response drove each measurement.
      const openMap = { [planned.session]: planned.fixtureBehavior };
      const mapResponse = await context.request.post(url + '/api/qa/open-map', { data: { entries: openMap } });
      if (mapResponse.status() !== 200) throw new Error(`open-map swap failed before ${planned.state} on "${planned.title}": ${mapResponse.status()} ${await mapResponse.text()}`);

      // 9a. Fresh boot: reload returns the list to the resting state, and the
      //     init-armed boot signals re-arm on every navigation.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await deadline(page.evaluate(() => {
        if (typeof window.__qaLiveCardsReady === 'undefined') throw new Error('live-card boot signal missing: init script did not run');
        return window.__qaLiveCardsReady;
      }), `four live cards before ${planned.state} step`, 30_000);
      await deadline(page.evaluate(() => {
        if (typeof window.__qaSessionCatalogReady === 'undefined') throw new Error('session-catalog boot signal missing: init script did not run');
        return window.__qaSessionCatalogReady;
      }), `session catalog before ${planned.state} step`, 30_000);
      await page.evaluate(() => window.__qaTwoFrames());

      // 9b. Pre-click assertion (hard): resting heights everywhere, no status
      //     row anywhere on the list.
      const preClick = await measureLiveList();
      const preClickOk = preClick.cards.length === 4 && preClick.cards.every(card => {
        const restingHeight = restingHeightByTitle.get(card.title);
        return card.stateRow === false && restingHeight !== undefined && sameHeight(card.height, restingHeight);
      });
      if (!preClickOk) throw new Error(`pre-click resting assertion failed before ${planned.state} on "${planned.title}": ${JSON.stringify(preClick.cards)}`);
      activation.preClickRestingAsserted = activation.preClickRestingAsserted && preClickOk;

      // 9c. Arm, click, await the exact final status label, then measure
      //     after two animation frames - INCLUDING the activated card's own
      //     status-row rect and text, read in this SAME evaluate call, so
      //     the row geometry and the card heights are one atomic
      //     observation of the settled page (never an earlier snapshot).
      const step = await deadline(page.evaluate(async ({ title, label }) => {
        const activationAttempt = window.__qaActivateLiveCard(title, label);
        if (activationAttempt.armed !== true) throw new Error(activationAttempt.reason);
        const statusText = await activationAttempt.signal; // pre-armed observer saw the EXACT final label
        await window.__qaTwoFrames(); // layout settles across two vsync ticks
        const cards = [...document.querySelectorAll('.th-sidebar-live-list .th-overview-card')].map(card => {
          const rect = card.getBoundingClientRect();
          const row = card.querySelector('.th-overview-card-state');
          return {
            height: Math.round(rect.height * 100) / 100,
            width: Math.round(rect.width * 100) / 100,
            title: (card.querySelector('.th-overview-card-name')?.textContent ?? '').trim(),
            stateRow: row !== null,
            statusText: row !== null ? (row.querySelector('span')?.textContent ?? '').trim() : null,
          };
        });
        const measuredCard = [...document.querySelectorAll('.th-sidebar-live-list .th-overview-card')]
          .find(card => (card.querySelector('.th-overview-card-name')?.textContent ?? '').trim() === title);
        const row = measuredCard?.querySelector('.th-overview-card-state') ?? null;
        const rowRect = row?.getBoundingClientRect();
        const activatedRow = row === null || rowRect === undefined ? null : {
          text: (row.querySelector('span')?.textContent ?? '').trim(),
          height: Math.round(rowRect.height * 100) / 100,
          width: Math.round(rowRect.width * 100) / 100,
          top: Math.round(rowRect.top * 100) / 100,
          bottom: Math.round(rowRect.bottom * 100) / 100,
          visible: rowRect.height > 0 && rowRect.width > 0,
        };
        const port = document.querySelector('.th-sidebar-live');
        const scrollport = port === null ? null : { clientWidth: port.clientWidth, scrollHeight: port.scrollHeight };
        return { statusText, cards, activatedRow, scrollport };
      }, { title: planned.title, label: stateLabels[planned.state] }), `activation ${planned.state} on "${planned.title}"`, 30_000);
      const label = stateLabels[planned.state];
      const activated = step.cards.find(card => card.title === planned.title);
      if (activated === undefined) throw new Error(`activation step lost the "${planned.title}" card`);
      const rowTextAtMeasurement = step.activatedRow?.text === label && step.activatedRow?.visible === true;
      const labelMatches = activated.stateRow === true && step.statusText === label && rowTextAtMeasurement;
      if (!labelMatches) throw new Error(`activation ${planned.state} on "${planned.title}" resolved status ${JSON.stringify(step.statusText)} (row present: ${activated.stateRow}, row at measurement: ${JSON.stringify(step.activatedRow)}), expected exactly ${JSON.stringify(label)}`);
      activation.labelsMatchExpected = activation.labelsMatchExpected && labelMatches;
      const others = [];
      for (const card of step.cards) {
        if (card.title === planned.title) continue;
        others.push({ title: card.title, height: card.height, width: card.width, stateRow: card.stateRow });
        if (card.stateRow === false) {
          const restingHeight = restingHeightByTitle.get(card.title);
          if (restingHeight === undefined || !sameHeight(card.height, restingHeight)) activation.othersKeepRestingHeight = false;
        } else {
          activation.othersKeepRestingHeight = false; // isolated step: no other card may show a status row
        }
      }
      // 9c-2. Non-vacuousness invariant: the activated card's settled height
      //       MUST be strictly greater than the resting height measured for
      //       THAT SAME card in THIS step's preClick snapshot - the in-flow
      //       status row is taller by construction, so an "activated"
      //       height equal to rest means the measurement never captured a
      //       grown card (a vacuous step) and the run FAILs through
      //       computeStatus.
      const preClickSelf = preClick.cards.find(card => card.title === planned.title);
      const restingHeightAtClick = preClickSelf?.height ?? null;
      const heightDeltaOverResting = restingHeightAtClick === null ? null : Math.round((activated.height - restingHeightAtClick) * 100) / 100;
      const activatedGrew = restingHeightAtClick !== null && activated.height > restingHeightAtClick;

      // 9d. Screenshot of this step's isolated settled state - taken in the
      //     same measured state, BEFORE any navigation or reload - then
      //     IMMEDIATELY re-read the activated card from the live DOM to
      //     prove the status row was still on screen when the screenshot
      //     pixels were captured. The reload for the next step happens only
      //     in the next iteration's 9a.
      const shot = `sidebar-live-step${stepIndex + 1}-${planned.state}.png`;
      await page.locator('.th-sidebar-live').screenshot({ path: join(evidenceDir, shot) });
      report.screenshots.push(shot);
      const postShot = await deadline(page.evaluate((title) => {
        const card = [...document.querySelectorAll('.th-sidebar-live-list .th-overview-card')]
          .find(candidate => (candidate.querySelector('.th-overview-card-name')?.textContent ?? '').trim() === title);
        if (card === undefined) return { cardFound: false, stateRow: false, statusText: null, height: null };
        const row = card.querySelector('.th-overview-card-state');
        const rect = card.getBoundingClientRect();
        return {
          cardFound: true,
          stateRow: row !== null,
          statusText: row !== null ? (row.querySelector('span')?.textContent ?? '').trim() : null,
          height: Math.round(rect.height * 100) / 100,
        };
      }, planned.title), `post-screenshot state check for ${planned.state} on "${planned.title}"`, 30_000);
      const rowPresentAtScreenshot = postShot.cardFound === true && postShot.stateRow === true && postShot.statusText === label;
      stepRecords.push({ state: planned.state, title: planned.title, height: activated.height, width: activated.width });
      activation.steps.push({
        state: planned.state, session: planned.session, title: planned.title, screenshot: shot, openMap,
        statusText: step.statusText, expectedLabel: label, labelMatches,
        preClick: { cards: preClick.cards.map(card => ({ title: card.title, height: card.height, width: card.width, stateRow: card.stateRow })), scrollport: preClick.scrollport },
        activatedCard: { height: activated.height, width: activated.width },
        stateRowAtMeasurement: step.activatedRow,
        restingHeightAtClick, heightDeltaOverResting, activatedGrew,
        screenshotState: { stateRow: postShot.stateRow === true, statusText: postShot.statusText, height: postShot.height, rowPresentAtScreenshot },
        others, scrollport: step.scrollport,
      });
    }
    // Non-vacuousness and screenshot-state aggregates: every step's
    // activated card must have measured strictly taller than its own
    // preClick resting height, and every step screenshot must have been
    // taken with the status row still on screen. Both are required for
    // PASS (see computeStatus); a vacuous step cannot hide behind a green
    // same-state pair.
    activation.activatedCardsGrew = activation.steps.length === activationPlan.length
      && activation.steps.every(entry => entry.activatedGrew === true);
    activation.screenshotsShowStateRows = activation.steps.length === activationPlan.length
      && activation.steps.every(entry => entry.screenshotState.rowPresentAtScreenshot === true);
    // Same-state height equality across different sessions: a REQUIRED PASS
    // condition. Every same-state pair is compared; a pair is only
    // comparable when its measured widths are identical (within the same
    // sub-pixel tolerance), and a non-comparable pair fails the gate rather
    // than silently voiding it.
    activation.sameStateGate = evaluateSameStateGate(stepRecords, HEIGHT_TOLERANCE);
    activation.invariantsHold = activation.steps.length === activationPlan.length
      && activation.preClickRestingAsserted === true
      && activation.labelsMatchExpected === true
      && activation.othersKeepRestingHeight === true
      && report.restingFreeOfStateRows === true;

    // 10. Comparison against the RED baseline: every resting green height
    //     must be strictly greater than the RED title-only height.
    const comparison = {
      redBaselinePath, redTitleOnlyHeight: null, redTitleOnlyCardTitle: null,
      greenHeight: null, everyRestingHeightExceedsRedTitleOnly: false, error: null,
    };
    try {
      const red = JSON.parse(await readFile(join(repo, redBaselinePath), 'utf8'));
      const redCards = Array.isArray(red.cards) ? red.cards : [];
      const titleOnly = redCards.find(card => card?.title === 'Idle attached')
        ?? redCards.slice().sort((a, b) => (a?.height ?? 0) - (b?.height ?? 0))[0];
      if (titleOnly === undefined || typeof titleOnly.height !== 'number') {
        comparison.error = `RED baseline ${redBaselinePath} has no card heights to compare`;
      } else {
        comparison.redTitleOnlyHeight = titleOnly.height;
        comparison.redTitleOnlyCardTitle = titleOnly.title;
        comparison.greenHeight = restingHeights.length > 0 ? Math.min(...restingHeights) : null;
        comparison.everyRestingHeightExceedsRedTitleOnly = restingHeights.length > 0
          && restingHeights.every(height => height > titleOnly.height);
      }
    } catch (error) {
      comparison.error = `RED baseline ${redBaselinePath} could not be read: ${error?.message ?? error}`;
    }
    report.comparison = comparison;

    // PASS gate, exactly: resting cardCount 5, resting heightSpread 0,
    // metaCount 0, every resting height strictly greater than the RED
    // title-only height, in every activation step every card WITHOUT a
    // status row still measures the resting height, and every same-state
    // pair measures equal heights at identical widths. The gate is a pure
    // function so a fabricated mismatch can be shown to return FAIL without
    // a browser (recorded alongside the QA log).
    report.status = computeStatus(report);
  } catch (error) {
    report.errors.push({ message: error.message, stack: error.stack });
    if (!measured) report.status = 'BLOCKED';
    else report.status = 'FAIL';
    if (page && !page.isClosed()) { try { await page.screenshot({ path: join(evidenceDir, 'failure.png'), fullPage: true }); report.screenshots = [...report.screenshots, 'failure.png']; } catch {} }
  } finally {
    if (context) { try { await context.close(); report.cleanup.browserContextClosed = true; } catch (error) { report.cleanup.browserContextClosed = false; report.errors.push({ cleanup: 'browser', error: String(error) }); } }
    if (profile) {
      try { report.cleanup.chromeSweep = await sweepChromeProcesses(profile); } catch (error) { report.cleanup.chromeSweep = { swept: false, error: String(error) }; report.errors.push({ cleanup: 'chromeSweep', error: String(error) }); }
      if (decoy) {
        try { report.cleanup.ownershipProof = await proveSweepOwnership({ decoy, decoyProfile, profile }); } catch (error) { report.cleanup.ownershipProof = { proven: false, error: String(error) }; report.errors.push({ cleanup: 'ownershipProof', error: String(error) }); }
      } else {
        report.cleanup.ownershipProof = { proven: false, skipped: 'decoy not spawned - run failed before browser launch' };
      }
    } else {
      report.cleanup.chromeSweep = { swept: true, skipped: 'no profile created this run' };
    }
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
      `chrome swept by this run's profile ${profile ?? 'n/a'} (${report.cleanup.chromeSweep?.error !== undefined ? 'error' : report.cleanup.chromeSweep?.swept === true ? `selected ${JSON.stringify(report.cleanup.chromeSweep?.selectedPids ?? [])}, no leftovers` : `leftover ${JSON.stringify(report.cleanup.chromeSweep?.leftover ?? [])}`})`,
      `sweep ownership scoped to this run (${report.cleanup.ownershipProof?.proven === true ? `decoy pid ${report.cleanup.ownershipProof.decoyPid} carrying the shared prefix but a different profile was not selected and stayed alive` : 'NOT PROVEN'})`,
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
    console.log(JSON.stringify({
      status: report.status, cardCount: report.cardCount, heights: report.heights,
      heightSpread: report.heightSpread, metaCount: report.metaCount,
      activation: {
        steps: report.activation?.steps.length ?? 0,
        othersKeepRestingHeight: report.activation?.othersKeepRestingHeight ?? false,
        activatedCardsGrew: report.activation?.activatedCardsGrew ?? false,
        screenshotsShowStateRows: report.activation?.screenshotsShowStateRows ?? false,
        stepsSummary: (report.activation?.steps ?? []).map(step => ({ state: step.state, title: step.title, statusText: step.statusText, height: step.activatedCard.height, width: step.activatedCard.width, heightDeltaOverResting: step.heightDeltaOverResting, activatedGrew: step.activatedGrew, stateRowAtMeasurement: step.stateRowAtMeasurement, rowPresentAtScreenshot: step.screenshotState.rowPresentAtScreenshot, scrollport: step.scrollport })),
        sameStateGate: report.activation?.sameStateGate ?? null,
      },
      comparison: report.comparison === null ? null : {
        redTitleOnlyHeight: report.comparison.redTitleOnlyHeight,
        greenHeight: report.comparison.greenHeight,
        everyRestingHeightExceedsRedTitleOnly: report.comparison.everyRestingHeightExceedsRedTitleOnly,
      },
    }));
    process.exitCode = report.status === 'BLOCKED' ? 1 : 0; // FAIL is a valid measured result
  } catch (error) {
    console.error(error.message ?? error.stack);
    process.exitCode = 1;
  }
}

export { run, computeStatus, evaluateSameStateGate };
