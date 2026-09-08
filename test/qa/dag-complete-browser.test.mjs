import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSubagents, assertSurface, reconnectWithoutReplay, screenshotPath } from './dag-complete-browser.mjs';
import { chromePath, loadDriver } from './dag-complete-fixture.mjs';
import english from '../../frontend/src/i18n/locales/en.json' with { type: 'json' };

test('duplicate equal revision does not require a read; disconnect arms recovery before the native close', async () => {
  const events = [], waiters = [], timeline = [];
  let delivered = false, disconnected = false, armed = false, restored = false;
  const observed = { timeline, wait(predicate) {
    events.push('subscribe');
    return new Promise(resolve => waiters.push(row => { if (predicate(row)) resolve(row); }));
  } };
  const receipt = await reconnectWithoutReplay({
    frame: { type: 'extensionEvent' }, observed,
    gate: { arm() { assert.equal(delivered, true, 'duplicate packet must be processed without requiring an HTTP read'); armed = true; events.push('arm'); return { recovery: true }; } },
    deliver: async () => { delivered = true; events.push('duplicate-processed'); },
    assertCurrent: async () => { assert.equal(disconnected, false); events.push('retained-complete'); },
    disconnect() {
      assert.equal(armed, true); assert.equal(waiters.length, 2); disconnected = true; events.push('disconnect');
      for (const row of [{ kind: 'close', socketId: 1 }, { direction: 'sent', socketId: 2, frame: { type: 'chat.create', chatId: 'qa-chat' } }]) {
        timeline.push(row); for (const waiter of waiters) waiter(row);
      }
    },
    restore: async held => { assert.equal(disconnected, true); assert.equal(held.recovery, true); restored = true; events.push('HTTP-restored'); },
  });
  assert.equal(restored, true); assert.deepEqual(receipt, { beforeSocket: 1, afterSocket: 2, replayed: false });
  assert.deepEqual(events, ['duplicate-processed', 'retained-complete', 'subscribe', 'subscribe', 'arm', 'disconnect', 'HTTP-restored']);
});

test('reconnect proof rejects replay and propagates failed authoritative restoration', async () => {
  for (const outcome of ['replay', 'failed-HTTP']) {
    const timeline = [], waiters = [];
    const running = reconnectWithoutReplay({
      frame: {}, deliver: async () => {}, assertCurrent: async () => {}, gate: { arm: () => ({}) },
      observed: { timeline, wait: predicate => new Promise(resolve => waiters.push(row => { if (predicate(row)) resolve(row); })) },
      disconnect() {
        for (const row of [{ kind: 'close', socketId: 1 }, { direction: 'sent', socketId: 2, frame: { type: 'chat.create', chatId: 'qa-chat' } }]) {
          timeline.push(row); for (const waiter of waiters) waiter(row);
        }
        if (outcome === 'replay') timeline.push({ socketId: 2, direction: 'received', frame: { name: 'omo.dag.updated' } });
      },
      restore: async () => { if (outcome === 'failed-HTTP') throw new Error('authoritative HTTP failed'); },
    });
    await assert.rejects(running, outcome === 'replay' ? /no DAG replay/ : /authoritative HTTP failed/);
  }
});

const states = ['pending', 'blocked', 'scheduled', 'running', 'completed', 'failed', 'cancelled', 'skipped'];
function surfaceFixture() {
  const nodes = Array.from({ length: 64 }, (_, index) => ({ id: `node-${index}`, prompt: 'x'.repeat(2048), attempt: index,
    state: states[index % states.length], depends_on: Array.from({ length: index }, (_, from) => `node-${from}`) }));
  const expected = { run_id: 'dense-64', nodes, counts: { total: 64, ...Object.fromEntries(states.map(state => [state, 8])) },
    edges: nodes.flatMap(node => node.depends_on.map(from => ({ from, to: node.id }))) };
  const html = `<style>body{margin:0}svg{width:1280px;height:20px}</style>
    <section data-activity-dag-status="complete" data-content-token="${'a'.repeat(64)}">
    <select data-activity-dag-select><option value="dense-64">dense-64</option></select>
    <div class="th-chat-body" style="height:60px;overflow:auto"><div style="height:500px">transcript</div></div>
    <svg>${nodes.map((node, i) => `<g class="th-activity-gnode" data-node="${node.id}" transform="translate(${i * 20}, 0)"><rect width="10" height="10"/></g>`).join('')}
    ${expected.edges.map(edge => `<line class="th-activity-gedge" x1="${Number(edge.from.slice(5)) * 20 + 10}" y1="5" x2="${Number(edge.to.slice(5)) * 20}" y2="5"/>`).join('')}</svg>
    ${states.map(state => `<div data-activity-dag-count="${state}" data-count="8"></div>`).join('')}
    <details data-activity-dag-total="64"><summary>64</summary>
    ${nodes.map(node => `<details data-activity-dag-node="${node.id}"><summary>${node.id} - ${english[`activity.status.${node.state}`]}</summary>
      <dl><dd>${node.depends_on.map(dep => `<div>${dep}</div>`).join('')}</dd><dd data-activity-dag-attempt>${node.attempt}</dd></dl>
      <p data-activity-dag-prompt>${node.prompt}</p></details>`).join('')}</details>
    <ul>${nodes.map(node => `<li class="th-activity-dnode">${node.id}</li>`).join('')}</ul></section>`;
  return { expected, html };
}

test('Chrome surface observer proves 64 original identities/2016 edge endpoints and rejects dependency/state/text loss', { timeout: 30000 }, async () => {
  // This generated DOM tests the observer itself, not product rendering.
  const directory = await mkdtemp(join(tmpdir(), 'dag-observer-test-'));
  let browser;
  try {
    browser = await (await loadDriver()).launch({ executablePath: chromePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const { html, expected } = surfaceFixture();
    await page.setContent(html);
    const result = await assertSurface(page, expected, 'graph'); assert.equal(result.edges.length, 2016);
    await assertSurface(page, expected, 'list');
    const screenshot = await screenshotPath(page, join(directory, 'observer.png'));
    assert.equal(typeof screenshot, 'string');
    assert.deepEqual((await readFile(screenshot)).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.deepEqual(JSON.parse(JSON.stringify({ failureScreenshot: screenshot })), { failureScreenshot: screenshot });
    await page.evaluate(() => document.querySelector('[data-activity-dag-status]').setAttribute('data-activity-dag-status', 'stale'));
    await assert.rejects(assertSurface(page, expected, 'graph'));
    await assertSurface(page, expected, 'graph', 'stale');
    await page.setContent(html);
    for (const mutation of [
      () => document.querySelector('[data-activity-dag-node="node-63"] dd > div:last-child').remove(),
      () => document.querySelector('[data-activity-dag-node="node-0"] summary').textContent = 'node-0 - invalid',
      () => document.querySelector('[data-activity-dag-prompt]').textContent = 'x'.repeat(512),
      () => document.querySelector('.th-activity-gedge').setAttribute('x2', '9999'),
      () => document.querySelector('[data-activity-dag-total]').setAttribute('data-activity-dag-total', '1'),
    ]) {
      await page.evaluate(mutation); await assert.rejects(assertSurface(page, expected, 'graph')); await page.setContent(html);
    }
    // This is observer machinery, not a second synthetic product surface.
    for (const retained of [0, 1]) {
      await page.setContent(`<button data-activity-tab="agents" aria-selected="true"><span class="th-activity-tab-count">${english['activity.partial']}</span></button>
        <section data-activity-tabpanel="agents"><p class="th-activity-partial">${english['activity.partial']}</p></section>`);
      await assertSubagents(page, { partial: true, retained });
      await page.locator('.th-activity-tab-count').evaluate((node, value) => { node.textContent = value; }, `${retained}/${retained}`);
      await assert.rejects(assertSubagents(page, { partial: true, retained }));
    }
    await page.setContent('<button data-activity-tab="agents" aria-selected="true"><span class="th-activity-tab-count">2/2</span></button><section data-activity-tabpanel="agents"></section>');
    await assertSubagents(page, { partial: false, retained: 2 });
    await page.locator('.th-activity-tab-count').evaluate(node => { node.textContent = '1/1'; });
    await assert.rejects(assertSubagents(page, { partial: false, retained: 2 }));
  } finally {
    if (browser) { await browser.close(); assert.equal(browser.isConnected(), false); }
    await rm(directory, { recursive: true, force: true });
  }
});
