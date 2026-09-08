/** Built-SPA spinner regression: RED and GREEN run the SAME strict assertion.
 * bun test/qa/ui-dag-spinner.mjs --phase red|green --out DIR
 * Reuses activity readiness, bound Todo, real fixture and complete teardown.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DRIVER, identity, session, select, settled, subjectBounds } from './ui-followup-activity.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function sourceIdentity() {
  return { ...await identity(), spinnerRunner: sha(readFileSync(import.meta.filename)) };
}

/** Exported so the oracle itself can be regression-tested without a browser mock. */
export function assertTransparentRunning(glyphs) {
  assert.equal(glyphs.length, 2, 'both seeded running circles must exist');
  for (const glyph of glyphs) {
    assert.equal(glyph.tag, 'circle');
    assert.equal(glyph.fill, 'none', `${glyph.node}: getComputedStyle(circle).fill must be exactly none`);
  }
}

async function inspect(page) {
  return page.evaluate(() => {
    const paint = e => {
      const s = getComputedStyle(e), b = e.getBBox();
      return { node: e.closest('[data-node]').dataset.node, tag: e.tagName, text: e.textContent,
        fill: s.fill, stroke: s.stroke, strokeWidth: s.strokeWidth, dash: s.strokeDasharray,
        opacity: s.opacity, visibility: s.visibility, presentationFill: e.getAttribute('fill'),
        rect: e.getBoundingClientRect().toJSON(), box: { x: b.x, y: b.y, width: b.width, height: b.height },
        animationName: s.animationName, duration: s.animationDuration, transform: s.transform,
        transformBox: s.transformBox, transformOrigin: s.transformOrigin };
    };
    // Resolve the existing opaque palette with Chrome, without restyling DOM.
    const root = getComputedStyle(document.documentElement);
    const canvas = new OffscreenCanvas(1, 1).getContext('2d');
    const tokenFill = name => {
      canvas.fillStyle = root.getPropertyValue(name).trim();
      canvas.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
      if (a !== 255) throw new Error(`Expected opaque palette token ${name}`);
      return `rgb(${r}, ${g}, ${b})`;
    };
    return { theme: document.documentElement.dataset.theme, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      tokens: Object.fromEntries(['--th-text-dim', '--th-text', '--th-muted', '--th-bg'].map(name => [name, tokenFill(name)])),
      running: [...document.querySelectorAll('circle.th-activity-gstatus--running')].map(paint),
      checks: [...document.querySelectorAll('text.th-activity-gstatus--ok')].map(paint),
      errors: [...document.querySelectorAll('text.th-activity-gstatus--error')].map(paint),
      labels: [...document.querySelectorAll('[data-node] .th-activity-glabel')].map(paint),
      words: [...document.querySelectorAll('[data-node] .th-activity-gstate')].map(paint) };
  });
}

function preserved(data) {
  assert.equal(data.checks.length, 2); assert.equal(data.errors.length, 1);
  assert.equal(data.words.length, 6); assert(data.labels.length >= 6);
  for (const glyph of [...data.running, ...data.checks, ...data.errors, ...data.labels, ...data.words]) {
    assert(glyph.box.width > 0 && glyph.box.height > 0, 'nonempty painted glyph geometry');
    assert.equal(glyph.visibility, 'visible'); assert.equal(glyph.opacity, '1');
  }
  for (const glyph of [...data.checks, ...data.errors]) {
    assert.equal(glyph.fill, data.tokens['--th-text-dim']);
    assert.notEqual(glyph.fill, 'none'); assert(glyph.text.length > 0);
  }
  for (const word of data.words) { assert(word.text.length > 0); assert.equal(word.fill, data.tokens['--th-muted']); }
  for (const label of data.labels) {
    assert(label.text.length > 0);
    assert.equal(label.fill, data.tokens[label.node === 'f' ? '--th-text-dim' : '--th-text']);
  }
  for (const ring of data.running) {
    assert.equal(ring.presentationFill, 'none');
    assert.notEqual(ring.stroke, 'none'); assert.equal(ring.strokeWidth, '1.5px');
    assert.equal(ring.dash, '23px, 8px'); assert.equal(ring.transformBox, 'fill-box');
    assert.equal(ring.animationName, data.reduced ? 'none' : 'th-dag-run-spin');
    if (!data.reduced) assert.equal(ring.duration, '1.2s');
  }
}

async function motionFrames(page) {
  // Time IS the behavior under test: two native compositor frames, no sleep or polling.
  return page.evaluate(() => new Promise((done, fail) => {
    let frame;
    const timer = setTimeout(() => { cancelAnimationFrame(frame); fail(new Error('Spinner frame deadline')); }, 8000);
    const snapshot = () => [...document.querySelectorAll('circle.th-activity-gstatus--running')].map(e => {
      const a = e.getAnimations().find(a => a.animationName === 'th-dag-run-spin');
      return { node: e.closest('[data-node]').dataset.node, transform: getComputedStyle(e).transform,
        time: a?.currentTime ?? null, state: a?.playState ?? null, iterations: a?.effect.getTiming().iterations === Infinity ? 'Infinity' : null };
    });
    frame = requestAnimationFrame(() => {
      const before = snapshot();
      frame = requestAnimationFrame(() => { clearTimeout(timer); done({ before, after: snapshot() }); });
    });
  }));
}

async function capture(q, name) {
  const geometry = [];
  for (const id of ['a', 'b', 'c', 'k', 'e', 'f']) geometry.push(await subjectBounds(q, { id }));
  const data = await inspect(q.page);
  const path = join(q.out, `${name}.png`);
  await q.page.screenshot({ path, animations: 'allow' });
  const detailPath = join(q.out, `${name}-graph.png`);
  await q.page.locator('.th-activity-graph').screenshot({ path: detailPath, animations: 'allow' });
  for (const file of [path, detailPath]) q.manifest.push({ name: file.split('/').at(-1), sha256: sha(readFileSync(file)), fixture: q.record.id, sourceIdentity: q.identityHash });
  return { data, geometry };
}

export async function run({ phase = 'green', out, qaPlaywright = DRIVER } = {}) {
  assert(['red', 'green'].includes(phase)); assert(out);
  out = resolve(out); mkdirSync(out, { recursive: true });
  const receipt = { phase, out, command: `bun test/qa/ui-dag-spinner.mjs --phase ${phase} --out ${out}`,
    startedAt: new Date().toISOString(), identity: await sourceIdentity(), fixtures: [], scenarios: [], manifest: [] };
  receipt.identityHash = sha(JSON.stringify(receipt.identity));
  let browser, profile, browserPid;
  try {
    const { chromium } = await import(qaPlaywright);
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-automation'] });
    const cdp = await browser.newBrowserCDPSession();
    try {
      const { arguments: args } = await cdp.send('Browser.getBrowserCommandLine');
      profile = args.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
      browserPid = (await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(p => p.type === 'browser')?.id;
      receipt.browser = { version: browser.version(), profile, pid: browserPid };
      assert(profile && browserPid, 'owned Chrome runtime identity');
    } finally { await cdp.detach(); }
    for (const theme of ['dark', 'light']) for (const reduced of [false, true]) {
      const name = `${theme}-${reduced ? 'reduced' : 'rotating'}`, scenario = { name };
      receipt.scenarios.push(scenario);
      try {
        await session(browser, receipt, { theme, reduced }, async q => {
          await select(q, 'dag'); await settled(q.page);
          const before = await capture(q, `${name}-before`);
          const motion = await motionFrames(q.page);
          const after = await capture(q, `${name}-after`);
          q.record.result = { before, motion, after };
          assert.equal(before.data.theme, theme); assert.equal(before.data.reduced, reduced);
          preserved(before.data); preserved(after.data);
          assert.equal(motion.before.length, 2); assert.equal(motion.after.length, 2);
          for (const [i, a] of motion.before.entries()) {
            const b = motion.after[i];
            if (reduced) { assert.equal(a.state, null); assert.equal(b.state, null); assert.equal(a.transform, 'none'); assert.equal(b.transform, 'none'); }
            else { assert.equal(a.state, 'running'); assert.equal(b.state, 'running'); assert.equal(a.iterations, 'Infinity'); assert(b.time > a.time); assert.notEqual(b.transform, a.transform); }
          }
          scenario.prerequisitesPassed = true;
          // Never invert or forgive this assertion for RED. Collect all themes,
          // retain their actual assertion failures, then exit nonzero below.
          assertTransparentRunning(before.data.running);
          assertTransparentRunning(after.data.running);
          return q.record.result;
        });
        scenario.ok = true;
      } catch (error) {
        scenario.ok = false;
        scenario.error = { message: String(error.stack ?? error), code: error.code, actual: error.actual, expected: error.expected, operator: error.operator };
      }
      console.log(`${scenario.ok ? 'PASS' : 'FAIL'} ${name}${scenario.error ? ': ' + scenario.error.message.split('\n')[0] : ''}`);
    }
  } catch (error) { receipt.failure = String(error.stack ?? error); }
  finally {
    if (browser) {
      const disconnected = once(browser, 'disconnected'); await browser.close(); await disconnected;
      let processGone = false;
      if (browserPid) {
        try { process.kill(browserPid, 0); }
        catch (error) { if (error.code !== 'ESRCH') throw error; processGone = true; }
      }
      receipt.cleanup = { browserClosed: !browser.isConnected(), contexts: browser.contexts().length, processGone, profileRemoved: !!profile && !existsSync(profile) };
    }
    receipt.identityAfter = await sourceIdentity();
    receipt.sourceStable = JSON.stringify(receipt.identity) === JSON.stringify(receipt.identityAfter);
    receipt.pendingWorkZero = receipt.fixtures.length === 4 && receipt.fixtures.every(f => f.cleanup.contextClosed && f.cleanup.fixture?.serverStopped && f.cleanup.portClosed === 'ECONNREFUSED' && ['pendingWebSockets', 'pendingOpens', 'pendingCreates'].every(k => f.cleanup.fixture[k] === 0) && f.cleanup.errors.length === 0);
    receipt.verdict = !receipt.failure && receipt.scenarios.length === 4 && receipt.scenarios.every(s => s.ok) && receipt.sourceStable && receipt.pendingWorkZero && receipt.cleanup?.browserClosed && receipt.cleanup.contexts === 0 && receipt.cleanup.processGone && receipt.cleanup.profileRemoved ? 'PASS' : 'FAIL';
    receipt.finishedAt = new Date().toISOString();
    writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(receipt.manifest, null, 2));
  }
  assert.equal(receipt.verdict, 'PASS', `spinner ${phase} failed; see ${join(out, 'receipt.json')}`);
  return { verdict: receipt.verdict, scenarios: receipt.scenarios.length, pngs: receipt.manifest.length, out };
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  try { console.log(await run({ phase: args[args.indexOf('--phase') + 1], out: args[args.indexOf('--out') + 1], qaPlaywright: process.env.QA_PLAYWRIGHT ?? DRIVER })); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
