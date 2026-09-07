/** Actual built SPA tool-panel preservation QA; no user backend/profile.
 * QA_PLAYWRIGHT=<installed-driver> bun test/qa/ui-followup-toolbox.mjs --phase green --out ABSOLUTE_NEW_DIRECTORY
 * 60 state images: themes x desktop/mobile x en/ko x six states at font13,
 * plus themes x mobile/ko/font24 x six states. Motion frames are separate.
 * --scenario LABEL is explicitly a focused proof, never full acceptance.
 * --phase red retains historical material-baseline support; mutation proofs
 * use green and must actually fail. No build or product mutation in this runner.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { designSeed, installSignals, arm, complete, wheel, output } from './design-workbench-fixture.mjs';
import { startFixture } from './pane-workspace-ui.mjs';
import { closeResources, exposeTranscript, settleFrame, parseComputedColor } from './ui-theme-evidence.mjs';

export const SCENARIOS = ['dark', 'light'].flatMap(theme => [
  ...[{ width: 1280, height: 800 }, { width: 390, height: 844 }].flatMap(viewport =>
    ['en', 'ko'].map(lang => ({ theme, viewport, lang, fontSize: 13 }))),
  { theme, viewport: { width: 390, height: 844 }, lang: 'ko', fontSize: 24 },
]).map(row => ({ ...row, label: `${row.viewport.width}x${row.viewport.height}-${row.theme}-${row.lang}-font${row.fontSize}` }));
const identity = '한국어_도구_실행기록_접근성_전체이름_보존_검증_아주긴작업식별자';
const path = '/fixture/아주긴한국어프로젝트경로/세션과출력보존검증/중첩된디렉터리/읽기대상파일.ts';
const command = '검증명령 --프로젝트=/fixture/아주긴한국어프로젝트경로/중첩디렉터리 --검증=도구출력과공개상태보존 --대상=긴한국어명령인수';
const finalLine = 'TOOLBOX_STREAM_FINAL_69';
const longOutput = `${output}\n${finalLine}`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const exec = promisify(execFile);
const selector = id => `[data-tool-call-id="design-${id}"]`;

async function sourceSnapshot() {
  const git = async args => (await exec('git', args)).stdout.trimEnd();
  const files = (await git(['ls-files', 'frontend/src', 'test/qa', 'frontend/package.json', 'frontend/package-lock.json', 'frontend/index.html', 'frontend/vite.config.ts', 'frontend/tsconfig.json'])).split('\n').filter(Boolean);
  const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(file))])));
  return { head: await git(['rev-parse', 'HEAD']), tree: await git(['rev-parse', 'HEAD^{tree}']),
    dirty: await git(['status', '--porcelain']), files: hashes, runner: { path: resolve('test/qa/ui-followup-toolbox.mjs'), sha256: hashes['test/qa/ui-followup-toolbox.mjs'] } };
}
async function buildSnapshot() {
  const dir = resolve('frontend/dist'), files = {};
  async function visit(part = '') {
    for (const entry of (await readdir(resolve(dir, part), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = part ? `${part}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(file);
      else { const bytes = await readFile(resolve(dir, file)); files[file] = { sha256: hash(bytes), byteLength: bytes.length }; }
    }
  }
  await visit();
  return { dir, files };
}
function seed() {
  const value = designSeed('single');
  value.running = [];
  value.runs['stored-a'].queue = { revision: 1, items: [], engine: { pendingMessageCount: 0, ordered: [] } };
  for (const entry of value.runs['stored-a'].entries) {
    const message = entry.message;
    if (Array.isArray(message.content)) for (const item of message.content) {
      if (item.type === 'toolCall') {
        item.name = identity;
        item.arguments = item.id === 'design-read' ? { path } : { command };
      }
    }
    if (message.role === 'toolResult') { message.toolName = identity; message.content = [{ type: 'text', text: longOutput }]; }
  }
  return value;
}

/** Read-only DOM/computed geometry. Ellipsis may paint, never truncate source. */
function probePage(id) {
  const card = document.querySelector(`[data-tool-call-id="design-${id}"]`);
  if (!card) return { present: false, id };
  const rect = el => el?.getBoundingClientRect().toJSON() ?? null;
  const head = card.querySelector('.th-tool-head'), status = card.querySelector('.th-tool-status');
  const glyph = card.querySelector('.th-tool-glyph'), out = card.querySelector('.th-tool-output');
  const parent = card.closest('.th-chat-body'), footer = document.querySelector('.th-chat-controls');
  const style = getComputedStyle(card), headBox = rect(head), statusBox = rect(status), glyphBox = rect(glyph);
  const hit = el => {
    const box = rect(el);
    return !!box && el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  };
  return { id, present: true, name: card.querySelector('.th-tool-name')?.textContent,
    accessibleText: head.textContent, command: card.querySelector('.th-tool-cmd')?.textContent,
    expandedSource: card.querySelector('.th-tool-body .th-tool-io')?.textContent ?? null,
    expanded: head.getAttribute('aria-expanded') === 'true', preview: card.querySelector('.th-tool-preview')?.textContent,
    status: status.textContent, statusClass: status.className, glyphClass: glyph.className,
    card: rect(card), header: headBox, statusBox, glyphBox, chevron: rect(card.querySelector('.th-tool-chevron')),
    headerHit: hit(head), statusHit: hit(status), headerFontSize: getComputedStyle(head).fontSize,
    background: style.backgroundColor, border: { color: style.borderTopColor, width: style.borderTopWidth, style: style.borderTopStyle },
    boxShadow: style.boxShadow, nameOverflow: getComputedStyle(card.querySelector('.th-tool-name')).textOverflow,
    canvas: getComputedStyle(document.querySelector('.th-chat-pane')).backgroundColor,
    prose: getComputedStyle(document.querySelector('.th-chat-markdown p')).backgroundColor,
    output: out ? { rect: rect(out), top: out.scrollTop, height: out.scrollHeight, client: out.clientHeight,
      overflow: getComputedStyle(out).overflowY, cap: Math.min(360, innerHeight * .45), text: out.textContent,
      lastLine: out.textContent.trim().split('\n').at(-1), hit: hit(out) } : null,
    parent: { top: parent.scrollTop, left: parent.scrollLeft, rect: rect(parent) },
    footer: { controls: rect(footer), composer: rect(document.querySelector('.th-chat-input')) },
    page: { x: scrollX, y: scrollY, width: document.documentElement.scrollWidth, innerWidth, innerHeight },
    locale: localStorage.getItem('th-lang'), fontSize: localStorage.getItem('th-font-size'),
    motion: { reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      transform: getComputedStyle(glyph).transform, borderTop: getComputedStyle(glyph).borderTopColor,
      borderRight: getComputedStyle(glyph).borderRightColor,
      animations: glyph.getAnimations().map(a => ({ name: a.animationName, state: a.playState, time: a.currentTime,
        duration: a.effect.getTiming().duration, iterations: a.effect.getTiming().iterations === Infinity ? 'Infinity' : a.effect.getTiming().iterations })) } };
}

export async function run({ phase = 'green', out, driver = process.env.QA_PLAYWRIGHT, scenario }) {
  assert(['red', 'green'].includes(phase));
  assert(driver, 'QA_PLAYWRIGHT must point to an installed driver');
  assert(out, 'out is required');
  out = resolve(out);
  await mkdir(out, { recursive: true });
  assert.equal((await readdir(out)).length, 0, 'Evidence directory must be new/empty; preserve previous attempts');
  const scenarios = scenario ? SCENARIOS.filter(row => row.label === scenario) : SCENARIOS;
  assert(scenarios.length, `Unknown scenario ${scenario}`);
  const save = (name, value) => writeFile(resolve(out, name), JSON.stringify(value, null, 2) + '\n');
  const runnerBytes = await readFile(new URL(import.meta.url));
  const runnerSource = resolve(out, 'runner-source.mjs');
  await writeFile(runnerSource, runnerBytes);
  const receipt = { phase, out, driver, cwd: process.cwd(), startedAt: new Date().toISOString(),
    runnerSource: { path: runnerSource, sha256: hash(runnerBytes), byteLength: runnerBytes.length },
    command: `QA_PLAYWRIGHT=${driver} bun test/qa/ui-followup-toolbox.mjs --phase ${phase} --out ${out}${scenario ? ` --scenario ${scenario}` : ''}`,
    inventory: SCENARIOS, selectedScenarios: scenarios, fullMatrix: !scenario, expectedStateImages: scenarios.length * 6,
    seed: { identity, path, command, finalLine }, startSource: await sourceSnapshot(), startBuild: await buildSnapshot() };
  const observations = [], actions = [], images = [], served = [], sessions = [], resources = [], failures = [], motion = [];
  let browser;
  const check = (scenario, criterion, pass, detail) => {
    observations.push({ scenario, criterion, pass: !!pass, detail });
  };
  try {
    const { chromium } = await import(driver);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    receipt.browserVersion = browser.version();
    for (const config of scenarios) {
      const { label, theme, viewport, lang, fontSize } = config;
      const fixture = startFixture({ ...seed(), controlled: true, port: 0 });
      const resourceStart = resources.length;
      resources.push({ name: `${label}/fixture`, close: () => fixture.stop() });
      const context = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: 'no-preference' });
      resources.splice(resourceStart, 0, { name: `${label}/context`, close: async () => {
        await context.close(); return { contextClosed: true, url: fixture.url };
      } });
      const page = await context.newPage(); page.setDefaultTimeout(8000);
      const errors = [], responses = [];
      page.on('pageerror', error => errors.push(String(error)));
      page.on('response', response => {
        const url = new URL(response.url());
        if (url.origin !== fixture.url || !(url.pathname === '/' || /\.(?:js|css)$/.test(url.pathname))) return;
        // Register synchronously; drain each response body before finalizing.
        const pending = (async () => {
          const bytes = await response.body(), file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
          const row = { scenario: label, url: response.url(), status: response.status(), file, sha256: hash(bytes), byteLength: bytes.length,
            disk: receipt.startBuild.files[file] ?? null };
          served.push(row);
          check(label, `served/${file}`, row.status === 200 && row.disk?.sha256 === row.sha256 && row.disk?.byteLength === row.byteLength, row);
        })();
        // Retain rejections immediately, and still await the original promise.
        pending.catch(error => errors.push(`response body: ${error}`)); responses.push(pending);
      });
      sessions.push({ label, fixture, errors, responses });
      await installSignals(page, { theme, lang, fontSize });
      const action = async (kind, id, perform, detail = {}) => {
        const row = { id: actions.length, scenario: label, kind, tool: id, detail, before: id ? await page.evaluate(probePage, id) : null };
        actions.push(row);
        try { row.result = await perform(); }
        catch (error) { row.error = String(error); throw error; }
        finally { row.after = id ? await page.evaluate(probePage, id) : null; }
        return row;
      };
      console.log(`WORKING: ${label} actual SPA ${fixture.url}`);
      await action('navigation', null, async () => {
        const attached = fixture.wait('frame', frame => frame.type === 'chat.stats');
        await page.goto(fixture.url); await attached;
        await page.evaluate(() => window.qaSignal(() => !!document.querySelector('[data-tool-call-id="design-failed"]')
          && document.querySelector('.th-chat-status-num')?.textContent === '42%'));
      }, { url: fixture.url });
      const expose = (id, part = '.th-tool-head') => action('expose-transcript', id, async () => {
        await page.evaluate(settleFrame);
        // A DOM delivery can precede the transcript ResizeObserver's follow
        // adjustment. Observe its actual layout delivery before aligning it.
        await page.evaluate(() => new Promise((done, fail) => {
          const observer = new ResizeObserver(() => {
            observer.disconnect(); requestAnimationFrame(() => { clearTimeout(timer); done(true); });
          });
          const timer = setTimeout(() => { observer.disconnect(); fail(new Error('Transcript layout delivery deadline')); }, 8000);
          observer.observe(document.querySelector('.th-chat-content'));
        }));
        return page.evaluate(exposeTranscript, `${selector(id)} ${part}`);
      }, { selector: `${selector(id)} ${part}` });
      const toggle = (id, open) => action('disclosure', id, async () => {
        await page.evaluate(({ id, open }) => {
          window.qaPending = window.qaSignal(() => document.querySelector(`[data-tool-call-id="design-${id}"] .th-tool-head`)?.getAttribute('aria-expanded') === String(open));
        }, { id, open });
        await page.locator(`${selector(id)} .th-tool-head`).click(); await complete(page);
      }, { open });
      const deliver = (frame, predicate) => action('fixture-delivery', 'running', async () => {
        await arm(page, predicate); fixture.deliver('stored-a', frame); await complete(page);
      }, { frame });
      const capture = async (id, state, kind = 'state') => {
        const readiness = await page.evaluate(settleFrame);
        const before = await page.evaluate(probePage, id);
        const accessibility = await page.locator(`${selector(id)} .th-tool-head`).ariaSnapshot();
        const bytes = await page.screenshot({ animations: 'allow' });
        const file = resolve(out, `p4-${phase}-${label}-${state}.png`);
        await writeFile(file, bytes);
        const row = { path: file, sha256: hash(bytes), byteLength: bytes.length, scenario: label, kind, state, tool: id,
          actionIds: actions.filter(a => a.scenario === label).map(a => a.id), readiness, accessibility, before, after: await page.evaluate(probePage, id) };
        images.push(row); return row;
      };
      const locale = JSON.parse(await readFile(resolve(`frontend/src/i18n/locales/${lang}.json`), 'utf8'));
      const inspect = async (id, state, status, expanded, first) => {
        const p = await page.evaluate(probePage, id);
        p.accessibility = await page.locator(`${selector(id)} .th-tool-head`).ariaSnapshot();
        const bg = parseComputedColor(p.background), border = parseComputedColor(p.border.color), canvas = parseComputedColor(p.canvas), prose = parseComputedColor(p.prose);
        check(label, `material/${state}`, bg?.alpha === 1 && border?.alpha > 0 && p.border.width === '1px' && p.border.style === 'solid'
          && prose?.alpha === 0 && bg.rgb.join() !== canvas?.rgb.join() && p.boxShadow === 'none', p);
        check(label, `identity/${state}`, p.name === identity && p.accessibleText.includes(identity)
          && p.command.includes(id === 'read' ? path : command) && p.accessibility.includes(identity)
          && p.accessibility.includes(id === 'read' ? path : command), p);
        check(label, `locale-status/${state}`, p.locale === lang && p.fontSize === String(fontSize) && p.status === locale[`tool.${status === 'ok' ? 'done' : status === 'error' ? 'error' : 'running'}`]
          && p.glyphClass.includes(`th-tool-glyph--${status}`), p);
        check(label, `disclosure-bounds/${state}`, p.expanded === expanded && p.header.height >= 48 && p.headerHit && p.statusHit
          && p.statusBox.right <= p.header.right && p.statusBox.left >= p.header.left && p.chevron.width > 0
          && p.glyphBox.width > 0 && p.page.width <= p.page.innerWidth + 1, p);
        if (first) check(label, `persistent/${state}`, p.background === first.background && JSON.stringify(p.border) === JSON.stringify(first.border)
          && Math.abs(p.header.height - first.header.height) <= 1, p);
        if (expanded) {
          check(label, `expanded-source/${state}`, p.expandedSource.includes(id === 'read' ? path : command), p.expandedSource);
          check(label, `bounded-output/${state}`, p.output?.overflow === 'auto' && p.output.rect.height <= p.output.cap + 1
            && p.output.height > p.output.client && p.output.lastLine === finalLine, p.output);
        } else check(label, `preview/${state}`, !!p.preview?.length, p.preview);
        await capture(id, state);
        return p;
      };
      const scrollOutput = async id => {
        await expose(id, '.th-tool-output');
        for (const [gesture, delta] of [['wheel', 240], ['last-line', 1e7]]) {
          const row = await action(`output-${gesture}`, id, () => wheel(page, page.locator(`${selector(id)} .th-tool-output`), delta), { delta });
          const a = row.before, b = row.after;
          check(label, `output-owner/${id}/${gesture}`, b.output.top > a.output.top && a.parent.top === b.parent.top
            && a.parent.left === b.parent.left && JSON.stringify(a.parent.rect) === JSON.stringify(b.parent.rect)
            && a.footer.controls && a.footer.composer && JSON.stringify(a.footer) === JSON.stringify(b.footer)
            && a.page.x === b.page.x && a.page.y === b.page.y, row);
          if (gesture === 'last-line') check(label, `output-final/${id}`, Math.abs(b.output.top + b.output.client - b.output.height) <= 1
            && b.output.lastLine === finalLine, b.output);
        }
      };

      await expose('read');
      const completed = await inspect('read', 'completed-collapsed', 'ok', false);
      await toggle('read', true); await expose('read');
      await inspect('read', 'completed-expanded', 'ok', true, completed);
      await scrollOutput('read');
      await expose('read'); await toggle('read', false);
      await expose('failed');
      const failed = await inspect('failed', 'error-expanded', 'error', true);
      await toggle('failed', false); await expose('failed');
      await inspect('failed', 'error-collapsed', 'error', false, failed);

      await deliver({ type: 'tool', toolCallId: 'design-running', toolName: identity, phase: 'start', args: { command } },
        () => !!document.querySelector('[data-tool-call-id="design-running"]'));
      await deliver({ type: 'tool', toolCallId: 'design-running', toolName: identity, phase: 'update', partial: { content: [{ text: 'STREAM_START' }] } },
        () => document.querySelector('[data-tool-call-id="design-running"] .th-tool-preview')?.textContent === 'STREAM_START');
      await expose('running');
      const running = await inspect('running', 'running-collapsed', 'running', false);
      await toggle('running', true);
      const streaming = await deliver({ type: 'tool', toolCallId: 'design-running', toolName: identity, phase: 'update', partial: { content: [{ text: longOutput }] } },
        () => document.querySelector('[data-tool-call-id="design-running"] .th-tool-output')?.textContent.endsWith('TOOLBOX_STREAM_FINAL_69'));
      check(label, 'expanded-streaming', streaming.before.expanded && streaming.after.expanded
        && streaming.before.output.text === 'STREAM_START' && streaming.after.output.height > streaming.before.output.height, streaming);
      await expose('running');
      await inspect('running', 'running-expanded', 'running', true, running);
      await scrollOutput('running');
      await expose('running');

      // Bounded native frame observation of the existing glyph only. No P6
      // hidden-DAG policy, synthetic clock, new transition or card effect.
      const normal = await action('normal-motion-frames', 'running', () => page.evaluate(async () => {
        const glyph = document.querySelector('[data-tool-call-id="design-running"] .th-tool-glyph');
        let timer, frameId;
        try {
          return await Promise.race([(async () => {
            await Promise.all(glyph.getAnimations().map(a => a.ready));
            const sample = () => ({ transform: getComputedStyle(glyph).transform, times: glyph.getAnimations().map(a => a.currentTime) });
            const frame = () => new Promise(done => { frameId = requestAnimationFrame(() => done(sample())); });
            return [await frame(), await frame()];
          })(), new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('Glyph frame deadline')), 8000); })]);
        } finally { clearTimeout(timer); cancelAnimationFrame(frameId); }
      }));
      check(label, 'normal-glyph-motion', normal.before.motion.animations.some(a => a.name === 'th-tool-spin' && a.state === 'running')
        && normal.result[0].transform !== normal.result[1].transform, normal);
      if (fontSize === 24) await capture('running', 'motion-normal', 'motion');
      const reduced = await action('reduced-motion', 'running', async () => {
        await page.evaluate(() => {
          const media = matchMedia('(prefers-reduced-motion: reduce)');
          window.qaPending = new Promise((done, fail) => {
            const timer = setTimeout(() => { media.removeEventListener('change', changed); fail(new Error('Reduced-motion change deadline')); }, 8000);
            function changed(event) { if (event.matches) { clearTimeout(timer); media.removeEventListener('change', changed); done(true); } }
            media.addEventListener('change', changed);
          });
        });
        await page.emulateMedia({ reducedMotion: 'reduce' }); await complete(page);
        await page.evaluate(settleFrame);
      });
      check(label, 'reduced-glyph-static', reduced.after.motion.reduced && reduced.after.motion.animations.length === 0
        && reduced.after.motion.transform === 'none' && reduced.after.motion.borderTop !== reduced.after.motion.borderRight
        && reduced.after.glyphBox.width > 0 && reduced.after.glyphClass.includes('--running')
        && reduced.before.expanded === reduced.after.expanded, reduced);
      if (fontSize === 24) await capture('running', 'motion-reduced', 'motion');
      const terminal = await deliver({ type: 'tool', toolCallId: 'design-running', toolName: identity, phase: 'end', result: { content: [{ text: longOutput }] } },
        () => !!document.querySelector('[data-tool-call-id="design-running"] .th-tool-glyph--ok'));
      check(label, 'terminal-disclosure-preserved', terminal.before.expanded && terminal.after.expanded
        && terminal.after.status === locale['tool.done'] && terminal.after.glyphClass.includes('--ok'), terminal);
      if (fontSize === 24) await capture('running', 'motion-completed', 'motion');
      // Explicitly selected collapsed choice must survive an error update too.
      await toggle('running', false);
      const collapsedTerminal = await deliver({ type: 'tool', toolCallId: 'design-running', toolName: identity, phase: 'end', isError: true,
        result: { content: [{ text: longOutput }] } }, () => !!document.querySelector('[data-tool-call-id="design-running"] .th-tool-glyph--error'));
      check(label, 'collapsed-choice-preserved', !collapsedTerminal.before.expanded && !collapsedTerminal.after.expanded, collapsedTerminal);
      motion.push({ scenario: label, actionIds: [normal.id, reduced.id, terminal.id, collapsedTerminal.id] });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await Promise.all(responses);
      check(label, 'served-required', served.some(r => r.scenario === label && r.file === 'index.html')
        && served.some(r => r.scenario === label && r.file.endsWith('.js')) && served.some(r => r.scenario === label && r.file.endsWith('.css')), served.filter(r => r.scenario === label));
      check(label, 'no-user-send', fixture.frames.every(frame => frame.type !== 'chat.send'), fixture.frames.map(f => f.type));
    }
  } catch (error) { failures.push({ message: String(error), stack: error.stack }); }
  finally {
    for (const session of sessions) {
      try { await Promise.all(session.responses); }
      catch (error) { failures.push({ message: String(error), stack: error.stack }); }
      check(session.label, 'pageerrors', session.errors.length === 0, session.errors);
      check(session.label, 'unexpected-traffic', session.fixture.unexpected.length === 0, session.fixture.unexpected);
    }
    if (browser) resources.push({ name: 'browser', close: async () => { await browser.close(); return { browserClosed: !browser.isConnected() }; } });
    try { receipt.cleanup = await closeResources(resources, value => save('cleanup.json', value)); }
    catch (error) { failures.push({ message: String(error), stack: error.stack }); }
    receipt.endSource = await sourceSnapshot(); receipt.endBuild = await buildSnapshot();
    check('run', 'source-stable', JSON.stringify(receipt.startSource) === JSON.stringify(receipt.endSource), { start: receipt.startSource.runner, end: receipt.endSource.runner });
    check('run', 'build-stable', JSON.stringify(receipt.startBuild) === JSON.stringify(receipt.endBuild), null);
    check('run', 'complete-image-inventory', images.filter(i => i.kind === 'state').length === receipt.expectedStateImages, images.length);
    const mismatches = observations.filter(row => !row.pass);
    receipt.finishedAt = new Date().toISOString();
    receipt.passed = failures.length === 0 && (phase === 'green' ? mismatches.length === 0 : mismatches.some(row => row.criterion.startsWith('material/')));
    receipt.failures = failures;
    const runtime = sessions.map(({ label, fixture, errors }) => ({ scenario: label, url: fixture.url, pageerrors: errors,
      unexpectedTraffic: fixture.unexpected, frames: fixture.frames, traffic: fixture.traffic }));
    await save('observations.json', { observations, mismatches, actions, runtime });
    await save('served-assets.json', served);
    await save('motion.json', { scope: 'existing visible tool glyph only; no hidden-DAG policy', samples: motion, images: images.filter(i => i.kind === 'motion') });
    await save('manifest.json', { ...receipt, images, servedAssets: 'served-assets.json', observations: 'observations.json', motion: 'motion.json' });
    await save('summary.json', { passed: receipt.passed, fullMatrix: receipt.fullMatrix, scenarios: scenarios.length,
      observations: observations.length, mismatches: mismatches.map(r => `${r.scenario}/${r.criterion}`), failures,
      stateImages: images.filter(i => i.kind === 'state').length, motionImages: images.filter(i => i.kind === 'motion').length });
    console.log(JSON.stringify({ passed: receipt.passed, observations: observations.length, mismatches: mismatches.map(r => `${r.scenario}/${r.criterion}`), failures,
      stateImages: images.filter(i => i.kind === 'state').length, motionImages: images.filter(i => i.kind === 'motion').length, out }, null, 2));
  }
  assert(receipt.passed, `Toolbox QA failed; exact retained evidence: ${out}`);
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { phase: { type: 'string' }, out: { type: 'string' }, scenario: { type: 'string' } } });
  try { await run(values); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
