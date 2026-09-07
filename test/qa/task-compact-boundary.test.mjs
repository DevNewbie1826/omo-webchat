import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertBoundaryDOM, boundaryScenarios, loadProducerReceipt, remapProducerFrames } from './task-compact-boundary.mjs';
import { parseArgs, scenarios } from './task-state-ordering.mjs';
import { chat } from './task-state-fixture.mjs';

test('producer option is explicit and the original 14-case matrix remains intact', () => {
  assert.equal(scenarios.length * 2, 14);
  assert.equal(boundaryScenarios.length * 2, 8);
  assert.deepEqual(parseArgs(['--evidence-dir', '/tmp/proof', '--producer-dir', '/tmp/producer']), {
    evidenceDir: '/tmp/proof', producerDir: '/tmp/producer' });
  assert.throws(() => parseArgs(['--evidence-dir', '/tmp/proof', '--other', '/tmp/producer']));
  assert.throws(() => parseArgs(['--evidence-dir', '/tmp/proof', '--producer-dir', '--bad']));
});

for (const mode of ['compact-only', 'mixed']) test(`${mode} keeps emitted payload, compact provenance and clock byte-for-byte while remapping routing`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'task-producer-helper-'));
  try {
    await copyFile(new URL(`../../frontend/test/fixtures/task-compact-boundary/${mode}.json`, import.meta.url), join(directory, `emitted-${mode}.json`));
    const { receipt, sha256 } = await loadProducerReceipt(directory, mode);
    assert.match(sha256, /^[a-f0-9]{64}$/);
    for (const group of [receipt.frames, receipt.enrichmentFrames]) {
      const mapped = remapProducerFrames(group);
      assert.equal(mapped.length, group.length);
      for (const [i, frame] of mapped.entries()) {
        assert.equal(frame.sessionId, chat);
        assert.equal(group[i].sessionId, 'review-chat', 'original receipt immutable');
        assert.deepEqual({ ...frame, sessionId: 'review-chat' }, group[i]);
      }
    }
    assert.equal(receipt.frames[0].data.tasks[0].padding.length, 65536);
    assert.equal(receipt.frames.at(-1).data.tasks.length, mode === 'mixed' ? 2 : 1);
    const rich = receipt.enrichmentFrames[0].data.tasks.find(row => row.task_id === 'task-r');
    assert.equal(rich.task_summary, 'Full description');
    assert.equal(rich.status, 'completed'); assert.equal(rich.raw_status, 'running');
    assert.equal(rich.updated_at, receipt.expectedTask.updated_at);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('boundary DOM assertions reject rollback, descriptor loss, incorrect counts and lost mixed prefix', () => {
  const dom = { agentsSelected: true, sidebarPresent: true, sidebarRunning: 0, count: '0/3', agents: [
    { name: 'running', kind: 'th-activity-chip th-activity-chip--ok' },
    { name: 'pending', kind: 'th-activity-chip th-activity-chip--muted' },
    { name: 'marker', kind: 'th-activity-chip th-activity-chip--muted' },
  ] };
  const expected = { title: 'running', status: 'completed', total: 3 };
  assertBoundaryDOM(dom, expected);
  for (const mutate of [d => { d.agents[0].kind = 'th-activity-chip--running'; },
    d => { d.agents[0].name = 'task-r'; }, d => { d.sidebarRunning = 1; },
    d => { d.count = '0/2'; }, d => { d.agents.pop(); }, d => { d.agents[1].name = 'lost'; },
    d => { d.agentsSelected = false; }]) {
    const bad = structuredClone(dom); mutate(bad); assert.throws(() => assertBoundaryDOM(bad, expected));
  }
});
