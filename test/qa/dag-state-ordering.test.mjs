import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { activityPath, confirmPortReleased, createActivityGate, installDOMSignals,
  launchChild, parseArgs, snapshotAssets } from './dag-state-ordering.mjs';

function route({ path = activityPath, method = 'GET', fulfill, abort } = {}) {
  const calls = [];
  return { calls, request: () => ({ url: () => `http://127.0.0.1:1234${path}`, method: () => method }),
    fallback: async () => { calls.push({ action: 'fallback' }); },
    fulfill: async body => { calls.push({ action: 'fulfill', body }); await fulfill?.(body); },
    abort: async () => { calls.push({ action: 'abort' }); await abort?.(); } };
}

async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), 'dag-harness-test-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}

test('CLI validates every flag and accepts either flag order', () => {
  assert.deepEqual(parseArgs(['--evidence-dir', './proof', '--scenario', 'hydration']),
    { evidenceDir: resolve('proof'), scenario: 'hydration' });
  assert.equal(parseArgs(['--scenario', 'restart', '--evidence-dir', '/tmp/proof']).scenario, 'restart');
  assert.equal(parseArgs(['--evidence-dir', '/tmp/proof']).scenario, 'all');
  for (const args of [[], ['--evidence-dir'], ['--unknown', 'x'], ['--scenario', 'wrong', '--evidence-dir', 'x'],
    ['--scenario', 'all', '--scenario', 'restart', '--evidence-dir', 'x'],
    ['--evidence-dir', 'x', '--evidence-dir', 'y'], ['--evidence-dir', '--scenario']]) assert.throws(() => parseArgs(args));
});

test('gate intercepts only GET for the selected chat activity resource', async () => {
  const gate = createActivityGate();
  for (const options of [{ method: 'POST' }, { path: activityPath + '/extra' }, { path: activityPath.replace('stored-a', 'newer') }, { path: '/api/layout' }]) {
    const request = route(options); await gate.handle(request); assert.deepEqual(request.calls, [{ action: 'fallback' }]);
  }
  assert.equal(gate.requests.length, 0); assert.equal((await gate.stop()).heldRoutes, 0);
});

test('each overlapping actual request owns a token and its own response, including query strings', async () => {
  const gate = createActivityGate();
  const first = route(), second = route({ path: activityPath + '?generation=2' });
  const a = gate.next(), b = gate.next();
  const handledA = gate.handle(first), handledB = gate.handle(second);
  const [tokenA, tokenB] = await Promise.all([a, b]);
  assert.notEqual(tokenA, tokenB); assert.deepEqual(first.calls, []); assert.deepEqual(second.calls, []);
  await gate.release(tokenB, { generation: 2 }); await handledB;
  assert.deepEqual(first.calls, []); assert.equal(JSON.parse(second.calls[0].body.body).generation, 2);
  await gate.release(tokenA, { generation: 1 }); await handledA;
  assert.equal(JSON.parse(first.calls[0].body.body).generation, 1);
  await assert.rejects(gate.release(tokenA, {})); await assert.rejects(gate.release(999, {}));
  const receipt = await gate.stop(); assert.equal(receipt.heldRoutes, 0); assert.deepEqual(receipt.errors, []);
});

test('fulfillment completion, not a call to release, owns the release boundary', async () => {
  let finish;
  const response = new Promise(done => { finish = done; });
  const gate = createActivityGate(), request = route({ fulfill: () => response });
  const next = gate.next(); const handled = gate.handle(request); const token = await next;
  const releasing = gate.release(token, { accepted: true });
  assert.equal(gate.requests[0].state, 'releasing');
  await assert.rejects(gate.release(token, {}));
  finish(); await releasing; await handled;
  assert.equal(gate.requests[0].state, 'released'); await gate.stop();
});

test('teardown drains held routes and cancels pre-armed waiters even when one abort fails', async () => {
  const gate = createActivityGate();
  const first = route({ abort: () => { throw new Error('connection already lost'); } }), second = route();
  const a = gate.next(), b = gate.next();
  const handledA = gate.handle(first), handledB = gate.handle(second); await Promise.all([a, b]);
  const future = gate.next(); const cancelled = assert.rejects(future);
  const receipt = await gate.stop(); await Promise.all([handledA, handledB, cancelled]);
  assert.deepEqual(second.calls, [{ action: 'abort' }]);
  assert.equal(receipt.heldRoutes, 0); assert.equal(receipt.pendingWaiters, 0);
  assert.equal(receipt.errors.length, 1); assert.equal(receipt.errors[0].token, 1);
  assert.throws(() => gate.next());
  const late = route(); await gate.handle(late); assert.deepEqual(late.calls, [{ action: 'abort' }]);
});

test('failed fulfillment stays held for explicit cleanup rather than silently dropping a route', async () => {
  const gate = createActivityGate(), request = route({ fulfill: () => { throw new Error('fulfill failed'); } });
  const pending = gate.next(), handled = gate.handle(request); const token = await pending;
  await assert.rejects(gate.release(token, {})); assert.equal(gate.requests[0].state, 'held');
  const receipt = await gate.stop(); await handled;
  assert.equal(request.calls.at(-1).action, 'abort'); assert.deepEqual(receipt.errors, []);
});

test('production asset snapshot is independent, byte-hashed and removable without touching source', async t => {
  const source = await temporary(t); await mkdir(join(source, 'assets'));
  await writeFile(join(source, 'index.html'), '<script src="/assets/app.js"></script>');
  const bytes = Buffer.from([0, 1, 127, 255]); await writeFile(join(source, 'assets/app.js'), bytes);
  const snapshot = await snapshotAssets(source);
  t.after(() => rm(snapshot.directory, { recursive: true, force: true }));
  assert.notEqual(snapshot.directory, source);
  const asset = snapshot.files.find(file => file.path === 'assets/app.js');
  assert.equal(asset.sha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(asset.bytes, bytes.length);
  await writeFile(join(source, 'assets/app.js'), 'changed producer output');
  assert.deepEqual(await readFile(join(snapshot.directory, 'assets/app.js')), bytes);
  await rm(snapshot.directory, { recursive: true });
  await assert.rejects(access(snapshot.directory), { code: 'ENOENT' });
  assert.equal(await readFile(join(source, 'assets/app.js'), 'utf8'), 'changed producer output');
  await assert.rejects(snapshotAssets(join(source, 'missing')), { code: 'ENOENT' });
});

test('port receipt rejects an occupied port and succeeds only after exact server closure', async () => {
  const server = createServer(); const listening = once(server, 'listening'); server.listen(0, '127.0.0.1'); await listening;
  const port = server.address().port;
  try { await assert.rejects(confirmPortReleased(port), { code: 'EADDRINUSE' }); }
  finally { const closed = once(server, 'close'); server.close(); await closed; }
  assert.equal(await confirmPortReleased(port), true);
});

test('child launcher preserves nonzero status and signal and removes parent signal listeners', async () => {
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const exited = await launchChild(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' });
  assert.equal(exited.code, 7); assert.equal(exited.signal, null); assert.equal(exited.exited, true);
  assert.throws(() => process.kill(exited.pid, 0), { code: 'ESRCH' });
  const killed = await launchChild(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")'], { stdio: 'ignore' });
  assert.equal(killed.code, null); assert.equal(killed.signal, 'SIGTERM');
  await assert.rejects(launchChild('/no-such-dag-qa-executable', []), { code: 'ENOENT' });
  assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], before);
});

test('real Chrome fetch gating and mutation barriers cannot finish before their exact release/action', { timeout: 30_000 }, async t => {
  // A tiny document tests harness plumbing only; scenario QA separately uses frontend/dist.
  const server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><body></body></html>'); });
  const listening = once(server, 'listening'); server.listen(0, '127.0.0.1'); await listening;
  const port = server.address().port, gate = createActivityGate();
  let browser, page;
  try {
    const { chromium } = await import(pathToFileURL(process.env.QA_PLAYWRIGHT ?? '/private/tmp/omo-asar/node_modules/playwright-core/index.mjs').href);
    browser = await chromium.launch({ executablePath: process.env.QA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    page = await browser.newPage(); await installDOMSignals(page);
    await page.route(new RegExp(`${activityPath}(?:\\?.*)?$`), gate.handle);
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
    const a = gate.next(), b = gate.next();
    await page.evaluate(path => {
      window.responses = [];
      window.fetches = [1, 2].map(generation => fetch(`${path}?generation=${generation}`).then(response => response.json())
        .then(body => { window.responses.push(body); const node = document.createElement('output'); node.dataset.generation = body.generation; document.body.append(node); }));
      window.signal = window.__dagQA.arm(String(() => !!document.querySelector('output[data-generation="2"]')));
    }, activityPath);
    const tokens = await Promise.all([a, b]);
    assert.deepEqual(await page.evaluate(() => window.responses), []);
    const token2 = tokens.find(token => new URL(gate.requests.find(row => row.token === token).url).searchParams.get('generation') === '2');
    await gate.release(token2, { generation: 2 });
    await page.evaluate(() => window.__dagQA.done(window.signal));
    assert.deepEqual(await page.evaluate(() => window.responses), [{ generation: 2 }]);
    await gate.release(tokens.find(token => token !== token2), { generation: 1 });
    await page.evaluate(() => Promise.all(window.fetches));
    assert.deepEqual(await page.evaluate(() => window.responses), [{ generation: 2 }, { generation: 1 }]);
    await t.test('capture settlement awaits the real finite animation and records mounted paint geometry', async () => {
      await page.evaluate(() => {
        document.body.innerHTML = `<div class="th-chat-body" style="height:80px;overflow:auto"><div style="height:400px">transcript</div></div>
          <div class="th-activity-panel"><div class="th-activity-dag">
          <div class="th-activity-dag-head"><span class="th-activity-dag-name">fixture</span>
          <span class="th-activity-chip">completed</span><span class="th-activity-dag-counts">1/1</span></div>
          <div class="th-activity-dnode"><span class="th-activity-dnode-label">node</span><span class="th-activity-chip">completed</span></div>
          </div></div><div class="th-chat-input"><textarea></textarea></div>`;
        const node = document.querySelector('.th-activity-dnode');
        window.motion = node.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(10px)' }], { duration: 1000, fill: 'forwards' });
        window.motion.pause();
        const finished = window.motion.finished;
        // Observe subscription, but preserve the browser's actual completion promise.
        window.animationObserved = new Promise(resolve => Object.defineProperty(window.motion, 'finished', {
          get() { resolve(); return finished; },
        }));
        window.captureDone = false;
        window.capture = window.__dagQA.settle().then(receipt => { window.captureDone = true; return receipt; });
      });
      await page.evaluate(() => window.animationObserved);
      assert.equal(await page.evaluate(() => window.captureDone), false);
      await page.evaluate(() => window.motion.finish());
      const receipt = await page.evaluate(() => window.capture);
      assert.equal(receipt.fonts, 'loaded');
      assert.equal(receipt.finiteAnimations, 1);
      assert.equal(receipt.frames.length, 2);
      assert.ok(receipt.frames[1] > receipt.frames[0]);
      for (const key of ['dag', 'head', 'status', 'counts', 'node', 'nodeStatus', 'composer', 'transcript']) {
        assert.ok(receipt.regions[key].visible && receipt.regions[key].hit, key);
        assert.ok(receipt.regions[key].width > 0 && receipt.regions[key].height > 0, key);
      }
    });
    assert.equal(await page.evaluate(() => window.__dagQA.stop()), 0);
  } finally {
    const receipt = await gate.stop();
    try { if (browser) await browser.close(); }
    finally { const closed = once(server, 'close'); server.closeAllConnections(); server.close(); await closed; }
    assert.deepEqual(receipt.errors, []); assert.equal(await confirmPortReleased(port), true);
  }
});
