import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertDagHasNoPartial, assertList, assertSubagents, assertSurface, reconnectWithoutReplay, screenshotPath } from './dag-complete-browser.mjs';
import * as proof from './dag-complete-browser.mjs';
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
/** Synthetic DOM in the restored list contract: one section carries the
 * catalog state; each run is an article identified by its exact run ID with
 * its own graph/details and its own accepted identity token. */
function surfaceFixture(view = 'graph') {
  const nodes = Array.from({ length: 64 }, (_, index) => ({ id: `node-${index}`, prompt: 'x'.repeat(2048), attempt: index,
    state: states[index % states.length], depends_on: Array.from({ length: index }, (_, from) => `node-${from}`) }));
  const expected = { run_id: 'dense-64', name: 'dense-64', content_token: 'a'.repeat(64), nodes,
    counts: { total: 64, completed: 8, ...Object.fromEntries(states.map(state => [state, 8])) },
    edges: nodes.flatMap(node => node.depends_on.map(from => ({ from, to: node.id }))) };
  const body = view === 'graph'
    ? `<svg>${nodes.map((node, i) => `<g class="th-activity-gnode" data-node="${node.id}" transform="translate(${i * 20}, 0)"><rect width="10" height="10"/></g>`).join('')}
    ${expected.edges.map(edge => `<line class="th-activity-gedge" x1="${Number(edge.from.slice(5)) * 20 + 10}" y1="5" x2="${Number(edge.to.slice(5)) * 20}" y2="5"/>`).join('')}</svg>`
    : `<ul class="th-activity-dagnodes">${nodes.map(node => `<li class="th-activity-dnode">${node.id}</li>`).join('')}</ul>`;
  const html = `<style>body{margin:0}svg{width:1280px;height:20px}</style>
    <section class="th-activity-dag-complete" data-activity-dag-catalog="ready">
    <div class="th-chat-body" style="height:60px;overflow:auto"><div style="height:500px">transcript</div></div>
    <article class="th-activity-dag-run" data-activity-dag-run="dense-64" data-activity-dag-status="complete" data-content-token="${'a'.repeat(64)}">
    <div class="th-activity-dag"><div class="th-activity-dag-head"><span class="th-activity-dag-name">dense-64</span><span class="th-activity-dag-counts">8/64 done</span></div>${body}</div>
    ${states.map(state => `<div data-activity-dag-count="${state}" data-count="8"></div>`).join('')}
    <details data-activity-dag-total="64"><summary>64</summary>
    ${nodes.map(node => `<details data-activity-dag-node="${node.id}"><summary>${node.id} - ${english[`activity.status.${node.state}`]}</summary>
      <dl><dd>${node.depends_on.map(dep => `<div>${dep}</div>`).join('')}</dd><dd data-activity-dag-attempt>${node.attempt}</dd></dl>
      <p data-activity-dag-prompt>${node.prompt}</p></details>`).join('')}</details>
    </article></section>`;
  return { expected, html };
}

test('Chrome surface observer proves 64 original identities/2016 edge endpoints and rejects dependency/state/text/token loss', { timeout: 30000 }, async () => {
  // This generated DOM tests the observer itself, not product rendering.
  const directory = await mkdtemp(join(tmpdir(), 'dag-observer-test-'));
  let browser;
  try {
    browser = await (await loadDriver()).launch({ executablePath: chromePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const { html, expected } = surfaceFixture('graph');
    await page.setContent(html);
    const result = await assertSurface(page, expected, 'graph'); assert.equal(result.edges.length, 2016);
    await page.setContent(surfaceFixture('list').html);
    await assertSurface(page, expected, 'list');
    await page.setContent(html);
    const listed = await assertList(page, [expected]); assert.deepEqual(listed.names, ['dense-64']);
    assert.deepEqual(listed.ids, ['dense-64']); assert.deepEqual(listed.statuses, ['complete']);
    await assertDagHasNoPartial(page);
    await page.evaluate(() => {
      const panel = document.querySelector('section');
      panel.setAttribute('data-activity-tabpanel', 'dag');
      const note = document.createElement('p'); note.className = 'th-activity-partial'; note.textContent = 'partial sentinel'; panel.append(note);
    });
    await assert.rejects(assertDagHasNoPartial(page));
    await page.setContent(html);
    await page.evaluate(text => {
      const tab = document.createElement('button'); tab.setAttribute('data-activity-tab', 'dag');
      const count = document.createElement('span'); count.className = 'th-activity-tab-count'; count.textContent = text;
      tab.append(count); document.body.prepend(tab);
    }, '12+');
    await assert.rejects(assertDagHasNoPartial(page), /count slot/);
    await page.setContent(html);
    const screenshot = await screenshotPath(page, join(directory, 'observer.png'));
    assert.equal(typeof screenshot, 'string');
    assert.deepEqual((await readFile(screenshot)).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.deepEqual(JSON.parse(JSON.stringify({ failureScreenshot: screenshot })), { failureScreenshot: screenshot });
    await page.evaluate(() => document.querySelector('article[data-activity-dag-run]').setAttribute('data-activity-dag-status', 'stale'));
    await assert.rejects(assertSurface(page, expected, 'graph'));
    await assertSurface(page, expected, 'graph', 'stale');
    await page.setContent(html);
    for (const mutation of [
      () => document.querySelector('article [data-activity-dag-node="node-63"] dd > div:last-child').remove(),
      () => document.querySelector('article [data-activity-dag-node="node-0"] summary').textContent = 'node-0 - invalid',
      () => document.querySelector('article [data-activity-dag-prompt]').textContent = 'x'.repeat(512),
      () => document.querySelector('article .th-activity-gedge').setAttribute('x2', '9999'),
      () => document.querySelector('article details[data-activity-dag-total]').setAttribute('data-activity-dag-total', '1'),
      () => document.querySelector('article[data-activity-dag-run]').setAttribute('data-content-token', 'b'.repeat(64)),
      () => document.querySelector('article[data-activity-dag-run]').removeAttribute('data-content-token'),
      () => {
        const extra = document.createElement('details');
        extra.setAttribute('data-activity-dag-total', '64');
        document.querySelector('article[data-activity-dag-run]').append(extra);
      },
      () => document.querySelector('article .th-activity-gnode').remove(),
    ]) {
      await page.evaluate(mutation); await assert.rejects(assertSurface(page, expected, 'graph')); await page.setContent(html);
    }
    // This is observer machinery, not a second synthetic product surface.
    for (const retained of [0, 1, 12]) {
      const count = retained > 0 ? `${retained}/${retained}` : null;
      const rows = Array.from({ length: retained }, (_, index) => `<span class="th-activity-agent-name">agent-${index}</span>`).join('');
      await page.setContent(`<button data-activity-tab="agents" aria-selected="true"><span class="th-activity-tab-count">${count ?? ''}</span></button>
        <section data-activity-tabpanel="agents">${rows}</section>`);
      if (retained === 0) await page.evaluate(() => document.querySelector('.th-activity-tab-count').remove());
      await assertSubagents(page, { count, rows: retained });
      for (const wrong of [`${retained}/64`, '64/64', retained > 0 ? `${retained}+` : '0/0', '?']) {
        await page.evaluate(wrong => {
          const span = document.querySelector('.th-activity-tab-count');
          if (span === null) {
            const added = document.createElement('span'); added.className = 'th-activity-tab-count';
            document.querySelector('[data-activity-tab="agents"]').append(added);
            added.textContent = wrong;
          } else span.textContent = wrong;
        }, wrong);
        await assert.rejects(assertSubagents(page, { count, rows: retained }));
      }
      await page.evaluate(() => {
        document.querySelector('[data-activity-tab="agents"] .th-activity-tab-count')?.remove();
        const span = document.createElement('span'); span.className = 'th-activity-tab-count';
        span.textContent = document.querySelectorAll('.th-activity-agent-name').length
          ? `${document.querySelectorAll('.th-activity-agent-name').length}/${document.querySelectorAll('.th-activity-agent-name').length}` : '';
        document.querySelector('[data-activity-tab="agents"]').append(span);
        if (!document.querySelectorAll('.th-activity-agent-name').length) span.remove();
      });
      await assertSubagents(page, { count, rows: retained });
      await page.evaluate(() => {
        const tab = document.querySelector('[data-activity-tab="agents"]');
        tab.setAttribute('title', 'qualified');
        const note = document.createElement('p'); note.className = 'th-activity-partial'; note.textContent = 'sentinel';
        document.querySelector('[data-activity-tabpanel="agents"]').append(note);
      });
      await assert.rejects(assertSubagents(page, { count, rows: retained }));
    }
    await page.setContent('<button data-activity-tab="agents" aria-selected="true"><span class="th-activity-tab-count">2/2</span></button><section data-activity-tabpanel="agents"><span class="th-activity-agent-name">a</span><span class="th-activity-agent-name">b</span></section>');
    await assertSubagents(page, { count: '2/2', rows: 2 });
    for (const wrong of ['1/1', '2+', '?', '2/1']) {
      await page.locator('.th-activity-tab-count').evaluate((node, value) => { node.textContent = value; }, wrong);
      await assert.rejects(assertSubagents(page, { count: '2/2', rows: 2 }));
    }
    await page.evaluate(() => document.querySelector('.th-activity-agent-name').remove());
    await assert.rejects(assertSubagents(page, { count: '2/2', rows: 2 }));
  } finally {
    if (browser) { await browser.close(); assert.equal(browser.isConnected(), false); }
    await rm(directory, { recursive: true, force: true });
  }
});

test('painted tab bounds and expanded prompt proof reject crossing text, clipping, missing and closed bodies', { timeout: 30000 }, async () => {
  // Synthetic HTML is a negative-control harness for the exact lead observers, not product evidence.
  const browser = await (await loadDriver()).launch({ executablePath: chromePath, headless: true });
  let page;
  try {
    assert.equal(typeof proof.assertTabBounds, 'function');
    assert.equal(typeof proof.assertExpandedPrompt, 'function');
    page = await browser.newPage(); await proof.setupDOM(page);
    await page.route('**/observer', route => route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
    await page.goto('http://dag-machinery.test/observer');
    const node = { id: 'last', prompt: 'Description text'.repeat(128) };
    const run = { run_id: 'last-run', name: 'last-run', nodes: [node] };
    const html = `<style>body{margin:0;font:14px sans-serif}.tabs{display:flex;width:100%;gap:4px}button{flex:1;min-width:0;height:30px;display:flex;justify-content:center;gap:4px}.panel{height:180px;overflow:auto}p{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}</style>
      <div class="tabs">${['todo','agents','dag'].map(tab => `<button data-activity-tab="${tab}"><span class="th-activity-tab-label">${tab}</span><span class="th-activity-tab-count">12/12</span></button>`).join('')}</div>
      <div class="panel"><article class="th-activity-dag-run" data-activity-dag-run="last-run" data-activity-dag-status="complete"><div class="th-activity-dag"><span class="th-activity-dag-name">last-run</span></div><details data-activity-dag-total="1"><summary>Descriptions</summary><details data-activity-dag-node="last"><summary>Last node</summary><p data-activity-dag-prompt>${node.prompt}</p></details></details></article></div>`;
    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
      await page.setViewportSize(viewport); await page.setContent(html);
      const tabs = await proof.assertTabBounds(page); assert.equal(tabs.tabs.length, 3);
      // A small count span remains within the button while its painted text crosses the next button.
      await page.locator('[data-activity-tab="agents"] .th-activity-tab-count').evaluate(element => {
        element.style.width = '2px'; element.textContent = '9'.repeat(100);
      });
      await assert.rejects(proof.assertTabBounds(page), /tab.*(bounds|overlap)/);
      await page.setContent(html);
      await assert.rejects(proof.assertExpandedPrompt(page, node, 'start', run), /expanded/);
      await proof.descriptions(page, run, 'start');
      const start = await proof.assertExpandedPrompt(page, node, 'start', run);
      assert.equal(start.prompt, node.prompt); assert.equal(start.edge, 'start');
      await proof.descriptions(page, run, 'end');
      const end = await proof.assertExpandedPrompt(page, node, 'end', run);
      assert.equal(end.edge, 'end'); assert.ok(end.scroll.some(box => box.top > 0));
      for (const mutate of [
        () => document.querySelector('[data-activity-dag-node]').open = false,
        () => document.querySelector('[data-activity-dag-total]').open = false,
        () => document.querySelector('[data-activity-dag-prompt]').remove(),
        () => document.querySelector('[data-activity-dag-prompt]').style.visibility = 'hidden',
        () => document.querySelector('[data-activity-dag-prompt]').textContent = 'truncated',
        () => document.querySelector('.panel').scrollTop = 0,
      ]) {
        await page.evaluate(mutate);
        await assert.rejects(proof.assertExpandedPrompt(page, node, 'end', run));
        await page.setContent(html); await proof.descriptions(page, run, 'end');
      }
    }
  } finally {
    if (page && !page.isClosed()) await page.evaluate(() => window.__dagQA?.stop());
    await browser.close(); assert.equal(browser.isConnected(), false);
  }
});
