import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectedSiblingEntries, assertSiblingHistory, assertSiblingSnapshot, assertSiblingTraffic } from './rpc46-overflow-sibling.mjs';

const entries = expectedSiblingEntries('rpc46-sibling-selfcheck');
const owner = { chatId: 'chat-B', socketId: 7 };
const frame = (sequence, value, socketId = owner.socketId) => ({
  sequence, kind: 'frame', direction: 'received', socketId, frame: { sessionId: owner.chatId, ...value },
});
const history = () => [
  frame(10, { type: 'entries', entries: structuredClone(entries), final: false }),
  frame(11, { type: 'entries', entries: [], final: true, leafId: 'entry-2' }),
];
const snapshot = () => ({
  chatId: owner.chatId, wsId: 'workspace-B', readyChatId: owner.chatId, piSessionId: 'durable-B', socketId: owner.socketId,
  diskHeaderId: 'durable-B', entries: structuredClone(entries),
  provider: { path: 'isolated/B.jsonl', durableId: 'durable-B', routingId: 'rpc-B', cwd: 'isolated',
    leafId: 'entry-2', entryCount: 2, live: true, openCount: 1, prompts: null },
  messages: entries.map(entry => ({ role: entry.message.role, text: entry.message.content })),
  draft: 'rpc46-sibling-draft-selfcheck', enabled: true, streaming: false, compacting: false,
});
const trafficOwner = { chatId: owner.chatId, socketIds: [owner.socketId],
  diagnostics: ['QA_OVERFLOW_RECOVERY_EXHAUSTED', 'QA_MATCHED_COMPACTION_FAILURE'], after: 0 };

test('the actual sibling oracle accepts two distinct entries and an empty FINAL page', () => {
  assertSiblingHistory(history(), entries, owner);
  assertSiblingSnapshot(snapshot(), snapshot());
  assertSiblingTraffic(history(), trafficOwner);
});

for (const [name, mutate] of [
  ['empty B history with a valid final cursor', pages => { pages[0].frame.entries = []; }],
  ['A content substituted for B', pages => { pages[0].frame.entries[0].message.content = 'rpc46-history-001'; }],
  ['wrong B parent chain', pages => { pages[0].frame.entries[1].parentId = null; }],
  ['wrong B entry ID', pages => { pages[0].frame.entries[0].id = 'entry-A'; }],
  ['wrong B role', pages => { pages[0].frame.entries[1].message.role = 'user'; }],
  ['wrong B leaf', pages => { pages[1].frame.leafId = 'entry-1'; }],
  ['missing B leaf', pages => { delete pages[1].frame.leafId; }],
  ['wrong chat owner', pages => { pages[0].frame.sessionId = 'chat-A'; }],
  ['wrong native socket owner', pages => { pages[0].socketId = 8; }],
  ['missing final B page', pages => { pages.pop(); }],
  ['duplicate final B page', pages => { pages.push(structuredClone(pages[1])); }],
]) {
  test(`wire oracle rejects ${name}`, () => {
    const pages = history(); mutate(pages);
    assert.throws(() => assertSiblingHistory(pages, entries, owner), { code: 'ERR_ASSERTION' });
  });
}

for (const [name, mutate] of [
  ['empty durable history', value => { value.entries = []; }],
  ['wrong durable content', value => { value.entries[0].message.content = 'A content'; }],
  ['wrong durable leaf', value => { value.provider.leafId = 'entry-1'; }],
  ['wrong provider routing owner', value => { value.provider.routingId = 'rpc-A'; }],
  ['wrong provider durable owner', value => { value.piSessionId = 'durable-A'; }],
  ['wrong socket owner', value => { value.socketId = 8; }],
  ['wrong chat owner', value => { value.chatId = 'chat-A'; }],
  ['wrong disk header owner', value => { value.diskHeaderId = 'durable-A'; }],
  ['wrong DOM content', value => { value.messages[1].text = 'A content'; }],
  ['cleared draft', value => { value.draft = ''; }],
  ['disabled composer', value => { value.enabled = false; }],
  ['A prompt routed into B', value => { value.provider.prompts = ['rpc46-queued-head']; }],
  ['B lifecycle ownership changed', value => { value.compacting = true; }],
]) {
  test(`snapshot oracle rejects ${name}`, () => {
    const value = snapshot(); mutate(value);
    assert.throws(() => assertSiblingSnapshot(value, snapshot()), { code: 'ERR_ASSERTION' });
  });
}

for (const [name, row] of [
  ['standalone diagnostic', frame(12, { type: 'notice', message: trafficOwner.diagnostics[0] })],
  ['matched diagnostic', frame(12, { type: 'notice', message: trafficOwner.diagnostics[1] })],
  ['A session frame on B socket', frame(12, { type: 'notice', sessionId: 'chat-A', message: trafficOwner.diagnostics[0] })],
  ['B diagnostic on a foreign socket', frame(12, { type: 'notice', message: trafficOwner.diagnostics[0] }, 99)],
  ['application history error', frame(12, { type: 'error', message: 'Entry not found' })],
  ['unexpected settlement', frame(12, { type: 'run.done' })],
  ['unexpected compaction completion', frame(12, { type: 'compaction.done' })],
  ['native socket error', { sequence: 12, kind: 'socketerror', socketId: owner.socketId, error: 'closed' }],
]) {
  test(`traffic oracle rejects ${name}`, () => {
    assert.throws(() => assertSiblingTraffic([...history(), row], trafficOwner), { code: 'ERR_ASSERTION' });
  });
}

test('A diagnostic on A socket does not trip B, and deliberate viewport remount retains chat ownership', () => {
  const a = frame(12, { type: 'notice', sessionId: 'chat-A', message: trafficOwner.diagnostics[0] }, 8);
  const remounted = history().map(row => ({ ...row, socketId: 9 }));
  assertSiblingTraffic([...history(), a, ...remounted], { ...trafficOwner, socketIds: [7, 9] });
  assertSiblingHistory(remounted, entries, { ...owner, socketId: 9 });
  assertSiblingSnapshot({ ...snapshot(), socketId: 9 }, { ...snapshot(), socketId: 9 });
});
