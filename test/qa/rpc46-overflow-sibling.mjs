/** QA-only sibling oracle shared by the real browser runner and mutation proof. */
import assert from 'node:assert/strict';

export function expectedSiblingEntries(prefix) {
  return [
    { id: 'entry-1', parentId: null, type: 'message', message: { role: 'user', content: `${prefix}-001` } },
    { id: 'entry-2', parentId: 'entry-1', type: 'message', message: { role: 'assistant', content: `${prefix}-002` } },
  ];
}

export function assertSiblingHistory(pages, entries, owner) {
  assert.ok(pages.length > 0, 'B must receive history pages, not merely ready');
  for (const row of pages) {
    assert.equal(row.socketId, owner.socketId, 'B history native socket owner');
    assert.equal(row.frame.sessionId, owner.chatId, 'B history chat owner');
    assert.equal(row.frame.type, 'entries');
    assert.equal(typeof row.frame.final, 'boolean');
  }
  assert.equal(pages.filter(row => row.frame.final).length, 1, 'one final B history page');
  assert.equal(pages.at(-1).frame.final, true, 'B final page terminates history');
  assert.deepEqual(pages.flatMap(row => row.frame.entries), entries, 'B exact wire entries/content/parent chain');
  assert.equal(pages.at(-1).frame.leafId, entries.at(-1).id, 'B exact wire leaf');
}

export function assertSiblingSnapshot(actual, expected) {
  // Do not derive expected history from the observed page: an empty/wrong page
  // must fail even when DOM, disk and provider all agree with the wrong value.
  assert.deepEqual(actual, expected, 'B exact disk history, leaf, provider/chat/socket owner, DOM and draft survive');
}

export function assertSiblingTraffic(timeline, { chatId, socketIds, diagnostics, after }) {
  const rows = timeline.filter(row => row.sequence > after &&
    (socketIds.includes(row.socketId) || row.frame?.sessionId === chatId));
  for (const row of rows) {
    assert.notEqual(row.kind, 'socketerror', 'no B native socket error');
    if (row.kind !== 'frame') continue;
    const frame = row.frame;
    if (frame?.sessionId) assert.equal(frame.sessionId, chatId, 'B native socket never carries A session frames');
    if (frame?.type === 'chat.create') assert.equal(frame.chatId, chatId, 'B native socket never binds A');
    if (row.direction !== 'received') continue;
    assert.notEqual(frame?.type, 'error', 'no B application errors');
    assert.ok(!['run.started', 'run.done', 'compaction.started', 'compaction.done'].includes(frame?.type),
      'A recovery/replay/settlement never changes B lifecycle');
    for (const diagnostic of diagnostics) {
      assert.ok(!JSON.stringify(frame).includes(diagnostic), 'A diagnostic never reaches B');
    }
  }
}
