/** Replay actual Go subscriber receipts, with only an explicit routing remap. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chat } from './task-state-fixture.mjs';
import { armDOM, doneDOM, readTaskDOM, stamp } from './task-state-ordering.mjs';

export const boundaryScenarios = ['compact-only', 'mixed', 'compact-only-cold', 'mixed-cold'];

export async function loadProducerReceipt(directory, mode) {
  const path = join(directory, `emitted-${mode}.json`), bytes = await readFile(path);
  const receipt = JSON.parse(bytes);
  assert.deepEqual(receipt.expectedTask, { task_id: 'task-r', status: 'completed', raw_status: 'running', updated_at: stamp(2) });
  assert.equal(receipt.frames.length, mode === 'mixed' ? 3 : 2);
  for (const frame of [...receipt.frames, ...receipt.enrichmentFrames]) {
    assert.equal(frame.type, 'extensionEvent'); assert.equal(frame.name, 'omo.task.updated');
    assert.equal(frame.sessionId, 'review-chat');
    assert.equal(frame.data.parent_session_id, undefined, 'producer uses bound-socket ownership');
    assert.equal(frame.data.truncated_tasks, true);
  }
  const correction = receipt.frames.at(-1).data.tasks.find(row => row.task_id === 'task-r');
  assert.deepEqual(correction, receipt.expectedTask, 'the attached winner is compact, never invented rich data');
  assert.deepEqual(receipt.taskDigest.tasks.find(row => row.task_id === 'task-r'), correction);
  assert.equal(receipt.taskDigest.truncated, true);
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), receipt };
}

export function remapProducerFrames(frames) {
  return frames.map(frame => ({ ...frame, sessionId: chat }));
}

export function assertBoundaryDOM(dom, { title, status, total }) {
  assert.ok(dom.agentsSelected && dom.sidebarPresent);
  const targets = dom.agents.filter(row => row.name === title);
  assert.equal(targets.length, 1, 'exact producer target descriptor retained');
  assert.ok(targets[0].kind.split(' ').includes(`th-activity-chip--${status === 'running' ? 'running' : 'ok'}`));
  const running = status === 'running' ? 1 : 0;
  assert.equal(dom.count, `${running}/${total}`);
  assert.equal(dom.agents.length, total);
  assert.equal(dom.sidebarRunning, running);
  assert.equal(dom.agents.filter(row => row.kind.split(' ').includes('th-activity-chip--ok')).length, 1 - running);
  if (total === 3) assert.ok(dom.agents.some(row => row.name === 'pending' && row.kind.split(' ').includes('th-activity-chip--muted')));
}

export async function runBoundary({ scenario, producer, page, viewport, pollToken, activityToken,
  poll, hydrate, overview, attached, capture, record }) {
  const cold = scenario.endsWith('-cold'), mixed = scenario.startsWith('mixed');
  const { receipt } = producer, frames = remapProducerFrames(receipt.frames);
  const correction = frames.at(-1), enrichment = remapProducerFrames(receipt.enrichmentFrames);
  const total = mixed ? 3 : 2; // producer rows plus the independent REST application marker
  record({ action: 'producer-receipt', ...producer, identityRemap: { from: 'review-chat', to: chat,
    owner: 'ready.piSessionId/chat.create.chatId', payloadChanges: [] } });
  await poll(pollToken, null, 'boundary-initial-empty-REST');
  await hydrate(activityToken, null, 'boundary-initial-empty-history');
  // REST owns only the marker. Never prehydrate a rich completed correction.
  if (!cold) await attached(frames.slice(0, -1), 'producer-incumbent-prefix');
  const before = await page.evaluate(readTaskDOM);
  if (!cold) assert.equal(before.agents.find(row => row.name === 'running')?.kind.includes('th-activity-chip--running'), true);
  await overview([{ type: 'sessions.activity', sessionId: chat, durableSessionId: chat,
    snapshots: [{ name: 'omo.task.updated', oversized: true }], taskDigest: receipt.taskDigest,
    overflow: false }], 'producer-compact-digest');
  await attached([correction], 'producer-compact-correction');
  let title = cold ? 'task-r' : 'running';
  async function check(status, stage) {
    const dom = await page.evaluate(readTaskDOM);
    assertBoundaryDOM(dom, { title, status, total });
    record({ action: 'assert-producer-agents-sidebar-agreement', stage, status, title, total, dom });
    // The tree badge exposes running only. Its real overview exposes doneCount.
    if (viewport.width === 390) {
      const token = await armDOM(page, () => !!document.querySelector('.th-backdrop'));
      await page.locator('.th-mobile-menu').click(); await doneDOM(page, token);
    }
    const token = await armDOM(page, () => !!document.querySelector('.th-overview-card'));
    await page.getByRole('button', { name: 'Running sessions', exact: true }).click(); await doneDOM(page, token);
    const counts = await page.evaluate(() => {
      const card = [...document.querySelectorAll('.th-overview-card')].find(node => node.querySelector('.th-overview-card-name')?.textContent === 'Stored A');
      return { done: Number(card?.querySelector('.th-overview-card-stat')?.textContent.match(/\d+$/)?.[0]),
        running: Number.parseInt(card?.querySelector('.th-overview-card-running')?.textContent ?? '0', 10) };
    });
    assert.deepEqual(counts, { done: status === 'completed' ? 1 : 0, running: status === 'running' ? 1 : 0 });
    record({ action: 'assert-real-sidebar-overview-counts', stage, counts });
    await capture(`${stage}-overview`, { drawer: true });
    const closed = await armDOM(page, () => !document.querySelector('.th-overview'));
    await page.locator('.th-modal-close').click(); await doneDOM(page, closed);
    if (viewport.width === 390) {
      await capture(`${stage}-sidebar`, { drawer: true });
      const close = await armDOM(page, () => !document.querySelector('.th-backdrop'));
      await page.locator('.th-backdrop').click({ position: { x: 380, y: 100 } }); await doneDOM(page, close);
    }
    await capture(stage);
  }
  await check('completed', 'completed');
  await attached(enrichment, 'producer-equal-rich-enrichment');
  if (cold) title = 'Full description'; // AgentRow displays task_summary ahead of name.
  await check('completed', cold ? 'enriched' : 'descriptor-preserved');
  await attached(frames, 'producer-equal-raw-replay-after-enrichment');
  assertBoundaryDOM(await page.evaluate(readTaskDOM), { title, status: 'completed', total });
  // This input is intentionally raw (not a made-up rich completed correction).
  // A genuinely newer revision must revive through the actual same-ID App path.
  const revival = { type: 'extensionEvent', sessionId: chat, name: 'omo.task.updated', data: {
    tasks: [{ task_id: 'task-r', name: 'Newer raw revival', status: 'running', updated_at: stamp(4) }], truncated_tasks: true } };
  await overview([{ type: 'sessions.activity', sessionId: chat, durableSessionId: chat,
    snapshots: [{ name: revival.name, data: revival.data, oversized: false }], overflow: false }], 'genuine-newer-raw-revival-overview');
  await attached([revival], 'genuine-newer-raw-revival-attached'); title = 'Newer raw revival';
  await check('running', 'newer-revival');
  await attached([correction, ...enrichment], 'producer-old-correction-after-newer-revival');
  await overview([{ type: 'sessions.activity', sessionId: chat, durableSessionId: chat,
    snapshots: [{ name: correction.name, oversized: true }], taskDigest: receipt.taskDigest,
    overflow: false }], 'producer-old-digest-after-newer-revival');
  await check('running', 'revival-preserved');
}
