#!/usr/bin/env bun
/** Replay two snapshots of the actual 01a0d993 conversation on built SPA assets.
 * Capture: QA_PLAYWRIGHT=/tmp/qa-pw/node_modules/playwright/index.mjs bun test/qa/session-replay.mjs
 *   --build before|after|branch --assets /absolute/frontend/dist --evidence /absolute/before-after
 * Compose: same command with --compose --evidence /absolute/before-after.
 * The same script and HTTP/WS fixture serve all three independently built assets.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { startFixture } from './pane-workspace-ui.mjs';

const source = '/Users/mirage/.omo/agent/sessions/--Volumes-storage-workspace-cli-webchat--/2026-09-25T17-18-46-648Z_01a0d993-a378-72af-8fd8-9e6a44e20f4f.jsonl';
const originals = '/Volumes/storage/workspace/cli-webchat/.omo/evidence/visual-redesign/before-after/raw';
const cuts = { A: '4ed7e8d0', B: '0a6d2cc3' };
const builds = {
  before: '0d0994c8b6a004a9bbee2c4354646c7911d8a4d0',
  after: '9f8bce517da2fe2f2cb0aef480592c3952160e98',
  branch: process.env.QA_BRANCH_REF || '8d482929aadb35cfb44ab0fcf2134a4be4e04012',
};
const sizes = [{ width: 1280, height: 900 }, { width: 390, height: 844 }];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const escapeHtml = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function args(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--compose') options.compose = true;
    else if (['--build', '--assets', '--evidence'].includes(argv[i])) options[argv[i++].slice(2)] = argv[i];
    else throw new Error(`Unknown option ${argv[i]}`);
  }
  assert.ok(isAbsolute(options.evidence ?? ''), '--evidence needs an absolute directory');
  if (!options.compose) {
    assert.ok(builds[options.build], '--build must be before, after, or branch');
    assert.ok(isAbsolute(options.assets ?? ''), '--assets needs an absolute built dist');
  }
  assert.ok(process.env.QA_PLAYWRIGHT, 'Set QA_PLAYWRIGHT to installed Playwright index.mjs');
  return options;
}

async function transcript() {
  const lines = (await readFile(source, 'utf8')).split('\n');
  const windows = {};
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    const row = JSON.parse(lines[i]);
    if (row.type === 'message' || row.type === 'compaction') entries.push(row);
    for (const [name, id] of Object.entries(cuts)) {
      if (row.id === id) windows[name] = { entries: entries.slice(), lastLine: i + 1 };
    }
    if (row.id === cuts.B) break;
  }
  assert.deepEqual(Object.keys(windows).sort(), ['A', 'B'], 'Original snapshot IDs not found');
  const a = windows.A.entries.at(-1);
  const b = windows.B.entries.at(-1);
  assert.ok(a.message.content.some(block => block.type === 'text' && block.text.includes('진행하라고 하시면 1단계부터 시작하겠습니다.')));
  assert.equal(b.message.toolCallId, 'toolu_01XF1v5SqY1czawzxryQYbmZ');
  for (const [name, data] of Object.entries(windows)) {
    const callIds = new Set(data.entries.flatMap(entry => entry.message?.content?.filter(block => block.type === 'toolCall').map(block => block.id) ?? []));
    assert.ok(data.entries.filter(entry => entry.message?.role === 'toolResult' && callIds.has(entry.message.toolCallId)).length > 0,
      `${name} lacks the original tool result/call pair`);
  }
  return windows;
}

async function capture(options, chromium) {
  const windows = await transcript();
  const assets = options.assets;
  const index = await readFile(join(assets, 'index.html'));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const rows = [];
  try {
    for (const name of ['A', 'B']) for (const theme of ['dark', 'light']) for (const viewport of sizes) {
      const target = `${name}-${theme}-${viewport.width}`;
      const fixture = startFixture({ port: 0, assetsDir: assets, layout: 'single',
        runs: { 'stored-a': { entries: windows[name].entries } } });
      let context;
      try {
        context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'reduce' });
        const page = await context.newPage();
        page.setDefaultTimeout(12000);
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        await page.addInitScript(({ theme }) => {
          localStorage.setItem('th-lang', 'ko');
          localStorage.setItem('th-theme', theme);
          localStorage.setItem('th-font-size', '14');
          localStorage.setItem('th-ws-expanded', '["ws"]');
        }, { theme });
        const loaded = fixture.wait('frame', frame => frame.type === 'chat.stats');
        await page.goto(fixture.url);
        await loaded;
        await page.locator('.th-chat-body').waitFor();
        await page.evaluate(() => document.fonts.ready);
        await page.locator('[data-activity-tab="dag"]').click();
        // The original A/B panes show the selected DAG tab with its panel closed.
        // Clicking the same selected tab again closes it on all three builds.
        const activity = page.locator('.th-activity-shelf');
        if (await activity.getAttribute('data-open') === 'true') await page.locator('[data-activity-tab="dag"]').click();
        const tail = name === 'A' ? '진행하라고 하시면 1단계부터 시작하겠습니다.' : '루프 nextActions와 T2 DAG 진행을 확인합니다';
        // Arm the observer before touching scroll; the bound is a failure deadline, not a timed delay.
        await page.evaluate(({ name, tail }) => {
          window.sessionAnchorReady = new Promise((resolve, reject) => {
          const scroll = document.querySelector('.th-chat-body');
          const probe = () => {
            const found = name === 'A' ? scroll.textContent.includes(tail)
              : !![...scroll.querySelectorAll('.th-tool-cmd, .th-tool-summary')].find(node => node.textContent.includes(tail));
            if (found) { clearTimeout(timer); observer.disconnect(); resolve(); }
          };
          const observer = new MutationObserver(probe);
          const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`Original ${name} anchor did not mount`)); }, 12000);
          observer.observe(scroll, { childList: true, subtree: true, characterData: true });
          probe();
          });
        }, { name, tail });
        const scroll = page.locator('.th-chat-body');
        await scroll.evaluate(node => { node.scrollTop = node.scrollHeight; });
        await page.evaluate(() => window.sessionAnchorReady);
        // In B, compare the native closed state of the four visible tool calls and the one thinking disclosure.
        const state = await page.evaluate(({ name, tail }) => {
          const body = document.querySelector('.th-chat-body');
          const visible = element => {
            const rect = element.getBoundingClientRect(), owner = body.getBoundingClientRect();
            return rect.bottom > owner.top && rect.top < owner.bottom;
          };
          const tools = [...body.querySelectorAll('.th-tool')].filter(visible).map(node => ({
            id: node.dataset.toolCallId, summary: node.querySelector('.th-tool-summary, .th-tool-cmd')?.textContent?.slice(0, 100),
            expanded: node.querySelector('.th-tool-head')?.getAttribute('aria-expanded'),
          }));
          const thinking = [...body.querySelectorAll('.th-chat-thinking')].filter(visible)
            .map(node => node.querySelector('.th-chat-thinking-head')?.getAttribute('aria-expanded'));
          const anchor = name === 'A'
            ? [...body.querySelectorAll('p')].find(node => node.textContent.includes(tail))
            : [...body.querySelectorAll('.th-tool-summary, .th-tool-cmd')].find(node => node.textContent.includes(tail));
          return { scrollTop: body.scrollTop, maxScroll: body.scrollHeight - body.clientHeight,
            anchorText: tail, anchorY: anchor?.getBoundingClientRect().top ?? null,
            firstVisibleText: [...body.querySelectorAll('p,h1,h2,h3,li,.th-tool')].filter(visible).at(0)?.textContent?.slice(0, 110) ?? null,
            tools, thinking, dagTab: document.querySelector('[data-activity-tab="dag"]')?.getAttribute('aria-selected'),
            dagOpen: document.querySelector('.th-activity-shelf')?.getAttribute('data-open'),
            fontSize: getComputedStyle(document.documentElement).getPropertyValue('--th-font-size').trim(),
          };
        }, { name, tail });
        assert.equal(state.dagTab, 'true', `${target} DAG tab selection`);
        assert.equal(state.dagOpen, 'false', `${target} DAG shelf disclosure`);
        assert.equal(state.fontSize, '14px', `${target} font setting`);
        assert.equal(state.maxScroll - state.scrollTop, 0, `${target} scroll to tail`);
        assert.ok(state.anchorY !== null, `${target} original anchor not rendered`);
        if (name === 'B') assert.ok(state.tools.length >= 3, `${target} missing original eval cards`);
        assert.deepEqual(errors, [], `${target} page errors`);
        await page.mouse.move(viewport.width / 2, 8);
        const file = `session-${name}-${theme}-${viewport.width}-${options.build}.png`;
        const path = join(options.evidence, file);
        await page.screenshot({ path, animations: 'disabled' });
        const bytes = await readFile(path);
        const result = { name, theme, viewport: `${viewport.width}x${viewport.height}`, file, sha256: sha256(bytes),
          sourceCutId: cuts[name], sourceLine: windows[name].lastLine, originalEntryCount: windows[name].entries.length,
          ...state, cleanup: null };
        await context.close(); context = null;
        result.cleanup = await fixture.stop();
        assert.equal(result.cleanup.pendingWebSockets, 0, `${target} pending WebSockets`);
        rows.push(result);
        console.log(`CAPTURE ${options.build} ${target}: ${file} anchorY=${state.anchorY} scroll=${state.scrollTop}/${state.maxScroll}`);
      } finally {
        if (context) await context.close();
        if (rows.at(-1)?.name !== name || rows.at(-1)?.theme !== theme || rows.at(-1)?.viewport !== `${viewport.width}x${viewport.height}`)
          await fixture.stop();
      }
    }
    await writeFile(join(options.evidence, `session-${options.build}.json`),
      JSON.stringify({ build: options.build, sha: builds[options.build], assets, indexSha256: sha256(index),
        source, sourceSha256: sha256(JSON.stringify(windows.B.entries)), driver: 'test/qa/session-replay.mjs',
        screenshotDeviceScaleFactor: 2, states: rows }, null, 2) + '\n');
  } finally { await browser.close(); }
}

async function compose(evidence, chromium) {
  // Measured against the archived raws with visual-qa image-diff at native 2x size.
  // These are not a pixel-identity claim: source content/disclosures are the proof.
  const originalDiffRatios = {
    'A-dark-1280': [0.0423, 0.0385], 'A-dark-390': [0.0672, 0.0611],
    'A-light-1280': [0.0556, 0.0285], 'A-light-390': [0.0779, 0.0476],
    'B-dark-1280': [0.0506, 0.0392], 'B-dark-390': [0.0767, 0.0648],
    'B-light-1280': [0.0599, 0.0298], 'B-light-390': [0.0908, 0.0484],
  };
  const manifests = await Promise.all(Object.keys(builds).map(async build =>
    JSON.parse(await readFile(join(evidence, `session-${build}.json`), 'utf8'))));
  assert.deepEqual(manifests.map(item => item.sha), Object.values(builds));
  assert.equal(new Set(manifests.map(item => item.sourceSha256)).size, 1, 'Source transcript changed between captures');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const sheets = [];
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const name of ['A', 'B']) for (const theme of ['dark', 'light']) for (const viewport of sizes) {
      const key = `${name}-${theme}-${viewport.width}`;
      const rows = manifests.map(manifest => ({ manifest, state: manifest.states.find(row =>
        `${row.name}-${row.theme}-${row.viewport.split('x')[0]}` === key) }));
      for (const { state } of rows) assert.ok(state, `Missing ${key} capture`);
      const images = await Promise.all(rows.map(async ({ state }) => {
        const bytes = await readFile(join(evidence, state.file));
        assert.equal(sha256(bytes), state.sha256, `Stale image ${state.file}`);
        assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(bytes.readUInt32BE(16), viewport.width * 2);
        assert.equal(bytes.readUInt32BE(20), viewport.height * 2);
        return `data:image/png;base64,${bytes.toString('base64')}`;
      }));
      const width = viewport.width * 2, height = viewport.height * 2;
      await page.setViewportSize({ width: width * 3 + 36, height: height + 85 });
      const columns = rows.map(({ manifest, state }, i) =>
        `<section><header>${escapeHtml(manifest.build)} · ${escapeHtml(manifest.sha.slice(0, 10))}<small>original entry ${escapeHtml(state.sourceCutId)}, scroll ${state.scrollTop}/${state.maxScroll}, disclosure ${escapeHtml(JSON.stringify({ dag: state.dagOpen, tools: state.tools.map(t => t.expanded), thinking: state.thinking }))}</small></header><img src="${images[i]}" alt="${escapeHtml(state.file)}"></section>`);
      await page.setContent(`<html><head><style>*{box-sizing:border-box}body{margin:0;background:#151519;color:#eee;font:16px/1.35 -apple-system,sans-serif}h1{margin:0;padding:8px 10px;height:29px;font-size:16px}main{display:flex;gap:8px;padding:0 6px}section{width:${width}px;flex:none;border:1px solid #62626e}header{height:53px;padding:3px 9px;background:#292932}small{display:block;color:#b7b7c2;font-size:12px;overflow:hidden;white-space:nowrap}img{display:block;width:${width - 2}px;height:${height}px}</style></head><body><h1>Original session ${name} · ${theme} · ${viewport.width}x${viewport.height} · same driver and history state</h1><main>${columns.join('')}</main></body></html>`);
      assert.ok(await page.locator('img').evaluateAll(nodes => nodes.every(node => node.complete && node.naturalWidth > 0)));
      const file = `session-${key}.png`;
      await page.screenshot({ path: join(evidence, file), fullPage: true, animations: 'disabled' });
      const originalsForState = ['before', 'after'].map(build => join(originals, `${name}-${theme}-${viewport.width}-${build}.png`));
      sheets.push({ file, originalReference: originalsForState, columns: rows.map(({ manifest, state }) => ({
        build: manifest.build, sha: manifest.sha, sourceCutId: state.sourceCutId, sourceLine: state.sourceLine,
        originalEntryCount: state.originalEntryCount, file: state.file, sha256: state.sha256,
        anchorText: state.anchorText, anchorY: state.anchorY, scrollOffset: state.scrollTop,
        scrollMax: state.maxScroll, firstVisibleText: state.firstVisibleText,
        disclosure: { dagSelected: state.dagTab, dagOpen: state.dagOpen, tools: state.tools, thinking: state.thinking },
        ...(manifest.build === 'branch' ? { originalComparison: 'No original branch raw exists; third column is the current-build comparison, not a historical original.' }
          : { originalComparison: {
            image: join(originals, `${name}-${theme}-${viewport.width}-${manifest.build}.png`),
            imageDiffRatio: originalDiffRatios[key][manifest.build === 'before' ? 0 : 1],
            residual: 'Same source message window and tail anchor, but not pixel-identical: fixed shell/header/sidebar/segmented control, font rasterization and original capture timing differ. Original numeric scrollTop and pointer position were not preserved.',
          } }),
      })) });
      console.log(`SHEET ${file}`);
    }
  } finally { await browser.close(); }
  await writeFile(join(evidence, 'session-manifest.json'), JSON.stringify({
    source, sourceSha256: manifests[0].sourceSha256, driver: 'test/qa/session-replay.mjs',
    builds: manifests.map(({ build, sha, indexSha256, assets }) => ({ build, sha, indexSha256, assets })),
    method: 'Unmodified driver, exact original JSONL message/compaction entries through each snapshot ID; real fixture WS history and built SPA; native collapsed disclosures; bottom scroll; 2x Chrome screenshots. Source SHA-256 hashes the immutable B-window entries, not the still-growing session log.',
    originalScrollOffset: 'Not retained by original capture script; original frames show tail of the then-last entry. Replayed at scrollTop=scrollHeight-clientHeight and measured per column.',
    comparisonBoundary: 'Original raw screenshots exist only for the first two builds. Same source entries and viewport are replayed on the branch; the branch SHA names HEAD while its built assets also include concurrent uncommitted worktree edits (index SHA-256 identifies captured assets). Native idle sidebar/dag/composer states are used; original pointer position, absolute scrollTop and transient loading state are unavailable. These non-transcript details are visual proxies and are never claimed pixel-faithful.',
    sheets,
  }, null, 2) + '\n');
}

const options = args(process.argv.slice(2));
await mkdir(options.evidence, { recursive: true });
const { chromium } = await import(process.env.QA_PLAYWRIGHT);
if (options.compose) await compose(options.evidence, chromium);
else await capture(options, chromium);
