import assert from 'node:assert/strict';
import { join } from 'node:path';
import { installDOMSignals } from './dag-state-ordering.mjs';
import { assertComplete, bounded, createResponseGate } from './dag-complete-controls.mjs';
import english from '../../frontend/src/i18n/locales/en.json' with { type: 'json' };
import { save } from './dag-complete-fixture.mjs';

export const armDOM = (page, predicate, args) => page.evaluate(({ source, args }) => window.__dagQA.arm(source, args), { source: String(predicate), args });
export const doneDOM = (page, id) => page.evaluate(id => window.__dagQA.done(id), id);
export async function setupDOM(page) {
  await installDOMSignals(page);
  await page.addInitScript(() => {
    window.__dagQA.stop();
    localStorage.setItem('th-ws-expanded', '["qa-dag"]');
    window.__completeInitial = window.__dagQA.arm(String(() => !!document.querySelector('.th-chat-input textarea')
      && document.querySelector('.th-chat-body')?.textContent.includes('dag-transcript-99')));
  });
}
export async function actionDOM(page, predicate, action, args) {
  const signal = await armDOM(page, predicate, args); await action(); await doneDOM(page, signal);
}
export const statusIs = status => document.querySelector('[data-activity-dag-status]')?.getAttribute('data-activity-dag-status') === status;

export async function browserGate(page, receipts) {
  const gate = createResponseGate(request => fetch(request, { signal: AbortSignal.timeout(30000) }), receipts);
  const handlers = new Set(), errors = [];
  const handler = route => {
    const running = (async () => {
      const request = route.request();
      const response = await gate.handle(new Request(request.url(), { headers: await request.allHeaders() }));
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    })();
    handlers.add(running);
    running.catch(error => errors.push(String(error))).finally(() => handlers.delete(running));
    return running;
  };
  await page.route('**/dag-runs/*', handler);
  return { ...gate, async stop() {
    const receipt = await gate.stop(); await Promise.allSettled([...handlers]);
    await page.unroute('**/dag-runs/*', handler); return { ...receipt, errors };
  } };
}

/** Equal summaries need not refetch. Only the real reconnect owns a read barrier. */
export async function reconnectWithoutReplay({ deliver, frame, gate, observed, disconnect, assertCurrent, restore }) {
  await deliver(frame, 'oversized-live-snapshot-before-replay-loss');
  await assertCurrent();
  const closed = observed.wait(row => row.kind === 'close', { label: 'native disconnect' });
  const attached = observed.wait(row => row.direction === 'sent' && row.frame?.type === 'chat.create' && row.frame.chatId === 'qa-chat', { label: 'native reconnect' });
  const reconnect = gate.arm('dense-64');
  disconnect();
  const [before, after] = await Promise.all([closed, attached]);
  assert.notEqual(before.socketId, after.socketId);
  await restore(reconnect);
  assert.equal(observed.timeline.some(row => row.socketId === after.socketId && row.direction === 'received' && row.frame?.name === 'omo.dag.updated'), false, 'new native socket has no DAG replay');
  return { beforeSocket: before.socketId, afterSocket: after.socketId, replayed: false };
}

export async function assertSurface(page, expected, mode, expectedStatus = 'complete') {
  const observed = await page.evaluate(mode => {
    const nodes = [...document.querySelectorAll('.th-activity-gnode')];
    const geometry = nodes.map(node => {
      const [, x, y] = /translate\(([-\d.]+)[, ]+([-\d.]+)\)/.exec(node.getAttribute('transform'));
      const rect = node.querySelector('rect');
      return { id: node.dataset.node, x: Number(x), y: Number(y), width: Number(rect.getAttribute('width')), height: Number(rect.getAttribute('height')) };
    });
    const edges = [...document.querySelectorAll('.th-activity-gedge')].map(edge => {
      const from = geometry.find(node => node.x + node.width === Number(edge.getAttribute('x1')) && node.y + node.height / 2 === Number(edge.getAttribute('y1')));
      const to = geometry.find(node => node.x === Number(edge.getAttribute('x2')) && node.y + node.height / 2 === Number(edge.getAttribute('y2')));
      return { from: from?.id, to: to?.id };
    });
    const details = [...document.querySelectorAll('[data-activity-dag-node]')].map(node => ({
      id: node.getAttribute('data-activity-dag-node'), prompt: node.querySelector('[data-activity-dag-prompt]')?.textContent,
      depends_on: [...node.querySelectorAll('dd > div')].map(dep => dep.textContent),
      attempt: Number(node.querySelector('[data-activity-dag-attempt]')?.textContent),
      stateText: node.querySelector('summary')?.textContent,
      metadata: [...node.querySelectorAll('dd')].map(value => value.textContent),
    }));
    const transcript = document.querySelector('.th-chat-body');
    return { mode, status: document.querySelector('[data-activity-dag-status]')?.getAttribute('data-activity-dag-status'),
      token: document.querySelector('[data-content-token]')?.getAttribute('data-content-token'),
      selected: document.querySelector('[data-activity-dag-select]')?.value,
      total: Number(document.querySelector('[data-activity-dag-total]')?.getAttribute('data-activity-dag-total')),
      graphIDs: nodes.map(node => node.dataset.node), listCount: document.querySelectorAll('.th-activity-dnode').length,
      counts: Object.fromEntries([...document.querySelectorAll('[data-activity-dag-count]')].map(node => [node.getAttribute('data-activity-dag-count'), Number(node.getAttribute('data-count'))])),
      edges, details, transcript: { height: transcript?.scrollHeight, client: transcript?.clientHeight },
      viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth };
  }, mode);
  assert.equal(observed.status, expectedStatus); assert.equal(observed.selected, expected.run_id);
  assert.equal(observed.total, expected.nodes.length);
  const ids = expected.nodes.map(node => node.id);
  assert.deepEqual(observed.details.map(node => node.id), ids);
  for (const node of expected.nodes) {
    const detail = observed.details.find(item => item.id === node.id);
    for (const key of ['id', 'prompt', 'depends_on', 'attempt']) assert.deepEqual(detail[key], node[key]);
    assert.ok(detail.stateText.endsWith(` - ${english[`activity.status.${node.state}`]}`), `${node.id} state uses shipped translation`);
    for (const key of ['task_id', 'started_at', 'completed_at']) if (node[key] !== undefined) assert.ok(detail.metadata.includes(node[key]), `${node.id}.${key}`);
  }
  for (const [state, count] of Object.entries(expected.counts)) if (state !== 'total') assert.equal(observed.counts[state], count);
  if (mode === 'graph') {
    assert.deepEqual(observed.graphIDs, ids);
    const sorted = edges => edges.map(edge => JSON.stringify([edge.from, edge.to])).sort();
    assert.deepEqual(sorted(observed.edges), sorted(expected.edges));
  } else assert.equal(observed.listCount, ids.length);
  assert.ok(observed.transcript.height > observed.transcript.client, '100-message transcript genuinely overflows');
  assert.ok(observed.documentWidth <= observed.viewport.width, 'no document horizontal overflow');
  return observed;
}

export async function screenshotPath(page, path) {
  await page.screenshot({ path });
  return path;
}

export async function assertSubagents(page, { partial, retained }) {
  const observed = await page.evaluate(() => ({
    count: document.querySelector('[data-activity-tab="agents"] .th-activity-tab-count')?.textContent ?? null,
    partial: document.querySelector('[data-activity-tabpanel="agents"] .th-activity-partial')?.textContent ?? null,
    selected: document.querySelector('[data-activity-tab="agents"]')?.getAttribute('aria-selected'),
  }));
  assert.equal(observed.selected, 'true');
  if (partial) {
    assert.equal(observed.count, english['activity.partial']);
    assert.equal(observed.partial, english['activity.partial']);
    assert.notEqual(observed.count, `${retained}/${retained}`);
  } else {
    assert.equal(observed.count, '2/2');
    assert.equal(observed.partial, null);
  }
  return { ...observed, retained, qualified: partial };
}

export async function capture(page, evidenceDir, name, observation) {
  await bounded(page.evaluate(async () => {
    await document.fonts.ready;
    const animations = document.getAnimations().filter(item => Number.isFinite(item.effect.getComputedTiming().endTime) && !['finished', 'idle'].includes(item.playState));
    await Promise.all(animations.map(item => item.finished));
    await new Promise(requestAnimationFrame);
  }), 'font/animation capture settlement');
  const geometry = await page.evaluate(() => Object.fromEntries(['.th-chat-body', '.th-chat-input textarea', '.th-activity-panel'].map(selector => {
    const node = document.querySelector(selector), rect = node?.getBoundingClientRect();
    return [selector, rect && { ...rect.toJSON(), visible: node.checkVisibility() }];
  })));
  for (const box of Object.values(geometry)) assert.ok(box?.visible && box.width > 0 && box.height > 0
    && box.x >= 0 && box.y >= 0 && box.right <= observation.viewport.width + 1 && box.bottom <= observation.viewport.height + 1, 'bounded primary surface');
  await screenshotPath(page, join(evidenceDir, `${name}.png`));
  await save(evidenceDir, `${name}.json`, { ...observation, geometry });
}

export async function view(page, mode) {
  await actionDOM(page, mode => document.querySelector(`[data-view="${mode}"]`)?.getAttribute('aria-pressed') === 'true'
    && document.querySelectorAll(mode === 'graph' ? '.th-activity-gnode' : '.th-activity-dnode').length === 64,
  () => page.locator(`[data-view="${mode}"]`).click(), mode);
}

export async function descriptions(page, expected) {
  const parent = page.locator('details[data-activity-dag-total]');
  if (!await parent.evaluate(node => node.open)) await actionDOM(page, () => document.querySelector('details[data-activity-dag-total]')?.open,
    () => parent.locator(':scope > summary').click());
  const node = expected.nodes.at(-1), detail = page.locator(`[data-activity-dag-node="${node.id}"]`);
  if (!await detail.evaluate(element => element.open)) await actionDOM(page, id => document.querySelector(`[data-activity-dag-node="${id}"]`)?.open,
    () => detail.locator(':scope > summary').click(), node.id);
  const prompt = detail.locator('[data-activity-dag-prompt]');
  await prompt.scrollIntoViewIfNeeded(); assert.equal(await prompt.isVisible(), true);
  assert.equal(await prompt.textContent(), node.prompt);
  assert.equal(Buffer.byteLength(await prompt.textContent()), 2048);
  // Close the disclosure through its real control to restore graph space.
  await actionDOM(page, () => !document.querySelector('details[data-activity-dag-total]')?.open, () => parent.locator(':scope > summary').click());
}

export async function releaseComplete({ page, held, expected }) {
  const document = JSON.parse((await held.captured).body); assertComplete(document, expected);
  const signal = await armDOM(page, token => document.querySelector('[data-activity-dag-status]')?.getAttribute('data-activity-dag-status') === 'complete'
    && document.querySelector('[data-content-token]')?.getAttribute('data-content-token') === token, document.content_token);
  held.release(); await doneDOM(page, signal); return document;
}
