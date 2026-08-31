// Standalone event-driven tests for the mock pi RPC provider.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MOCK = join(dirname(fileURLToPath(import.meta.url)), 'mock-pi.mjs');
let pass = 0;
let fail = 0;
const ok = (condition, message) => {
  if (condition) pass++;
  else {
    fail++;
    console.error('  FAIL:', message);
  }
};

function runMock(env = {}, args = []) {
  const child = spawn(process.execPath, [MOCK, ...args], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const frames = [];
  const waiters = new Set();
  let buffer = '';

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); }
      catch (error) { frame = { __parseError: error.message, raw: line }; }
      frames.push(frame);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(frame)) {
          waiters.delete(waiter);
          waiter.signal.removeEventListener('abort', waiter.onTimeout);
          waiter.resolve(frame);
        }
      }
    }
  });

  function waitFor(predicate, description) {
    const existing = frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const signal = AbortSignal.timeout(2000);
      const waiter = {
        predicate,
        resolve,
        signal,
        onTimeout: () => {
          waiters.delete(waiter);
          reject(new Error(`timed out waiting for ${description}; frames=${frames.map((frame) => frame.type).join(',')}`));
        },
      };
      signal.addEventListener('abort', waiter.onTimeout, { once: true });
      waiters.add(waiter);
    });
  }

  function send(command) {
    child.stdin.write(JSON.stringify(command) + '\n');
  }

  async function close() {
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.stdin.end();
    await closed;
  }

  return { child, frames, waitFor, send, close };
}

// Basic omo stream and U+2028 framing.
{
  const mock = runMock({ MOCK_PI_UNICODE: '1', MOCK_PI_CHUNKS: '3' });
  const settled = mock.waitFor((frame) => frame.type === 'agent_settled', 'agent_settled');
  mock.send({ type: 'prompt', message: 'hello', id: 'r1' });
  await settled;
  await mock.close();

  const types = mock.frames.map((frame) => frame.type);
  ok(types[0] === 'response' && mock.frames[0].command === 'prompt' && mock.frames[0].success, 'prompt acked');
  ok(types.includes('agent_start') && types.includes('agent_settled'), 'has agent_start + agent_settled');
  ok(types.indexOf('agent_start') < types.indexOf('agent_settled'), 'agent_start before agent_settled');
  ok(types.includes('message_start') && types.includes('message_end'), 'has message_start/end');
  ok(mock.frames.filter((frame) => frame.type === 'agent_end').every((frame) => frame.willRetry === false && !('isTerminal' in frame)), 'agent_end uses observed willRetry fields');
  const deltas = mock.frames.filter((frame) => frame.type === 'message_update' && frame.assistantMessageEvent?.type === 'text_delta');
  ok(deltas.length === 3, `expected 3 text_delta, got ${deltas.length}`);
  const textEnd = mock.frames.find((frame) => frame.type === 'message_update' && frame.assistantMessageEvent?.type === 'text_end');
  ok(textEnd?.assistantMessageEvent.content.includes('\u2028'), 'U+2028 survived framing intact');
  ok(types[types.length - 1] === 'agent_settled', 'last frame is agent_settled');
}

// Abort after the exact first streamed delta.
{
  const mock = runMock({ MOCK_PI_CHUNKS: '50', MOCK_PI_CHUNK_MODE: 'signal' });
  const firstDelta = mock.waitFor(
    (frame) => frame.type === 'message_update' && frame.assistantMessageEvent?.type === 'text_delta',
    'first text_delta',
  );
  const settled = mock.waitFor((frame) => frame.type === 'agent_settled', 'agent_settled after abort');
  mock.send({ type: 'prompt', message: 'longlonglonglonglonglonglonglonglonglonglonglong', id: 'r2' });
  await firstDelta;
  const abortResponse = mock.waitFor(
    (frame) => frame.type === 'response' && frame.command === 'abort',
    'abort response',
  );
  mock.send({ type: 'abort', id: 'abort-1' });
  await Promise.all([abortResponse, settled]);
  await mock.close();

  const deltas = mock.frames.filter(
    (frame) => frame.type === 'message_update' && frame.assistantMessageEvent?.type === 'text_delta',
  );
  ok(deltas.length === 1, `abort barrier emitted exactly one delta, got ${deltas.length}`);
  const endMessage = mock.frames.find((frame) => frame.type === 'message_end');
  ok(endMessage?.message.stopReason === 'aborted', 'message_end stopReason=aborted');
}

// Approval round trip waits on request and settlement events.
{
  const mock = runMock({ MOCK_PI_APPROVE: '1', MOCK_PI_CHUNKS: '2' });
  const approval = mock.waitFor((frame) => frame.type === 'extension_ui_request' && frame.method === 'select', 'approval request');
  mock.send({ type: 'prompt', message: 'do a thing', id: 'r3' });
  const request = await approval;
  ok(request.id === 'approve-1', 'approval id is deterministic');
  ok(request.options?.length === 2, 'select has options');
  const settled = mock.waitFor((frame) => frame.type === 'agent_settled', 'settled after approval');
  mock.send({ type: 'extension_ui_response', id: request.id, value: 'Allow' });
  await settled;
  await mock.close();
  ok(mock.frames.some((frame) => frame.type === 'message_update' && frame.assistantMessageEvent?.type === 'text_delta'), 'streamed text after approval');
}

// Queries resolve from their exact response frames.
{
  const mock = runMock();
  const commands = mock.waitFor((frame) => frame.command === 'get_commands', 'get_commands response');
  const state = mock.waitFor((frame) => frame.command === 'get_state', 'get_state response');
  const stats = mock.waitFor((frame) => frame.command === 'get_session_stats', 'get_session_stats response');
  mock.send({ type: 'get_commands', id: 'c1' });
  mock.send({ type: 'get_state', id: 'c2' });
  mock.send({ type: 'get_session_stats', id: 'c3' });
  const [commandsFrame, stateFrame, statsFrame] = await Promise.all([commands, state, stats]);
  await mock.close();
  ok(commandsFrame.data.commands.length >= 1, 'get_commands returns list');
  const listed = commandsFrame.data.commands[0];
  ok(listed.syntax === 'slash' && listed.source === 'extension' && listed.sourceInfo?.path && listed.sourceInfo.source === 'cli' && listed.sourceInfo.baseDir === '/mock/base', 'extension commands include beta.11 source provenance metadata');
  const skill = commandsFrame.data.commands.find((entry) => entry.source === 'skill');
  ok(skill?.name === 'skill:demo' && skill.syntax === 'dollar' && skill.source === 'skill' && skill.sourceInfo?.source === 'cli' && skill.sourceInfo.baseDir === '/mock/base', 'skills preserve the skill: name prefix and CLI source provenance');
  ok(!('location' in listed), 'commands do not use fake location field');
  ok(stateFrame.data.model && stateFrame.data.sessionId === 'mock-omo-session', 'omo state returns model and identity');
  ok(statsFrame.data.tokens && statsFrame.data.contextUsage, 'get_session_stats returns tokens+contextUsage');
}

// Compact lifecycle is ordered and correlates both lifecycle events to the RPC request.
{
  const mock = runMock();
  const response = mock.waitFor((frame) => frame.type === 'response' && frame.command === 'compact', 'compact response');
  mock.send({ type: 'compact', id: 'compact-r1' });
  await response;
  await mock.close();
  const frames = mock.frames;
  const compact = frames.findIndex((frame) => frame.type === 'response' && frame.command === 'compact');
  const start = frames.findIndex((frame) => frame.type === 'compaction_start');
  const end = frames.findIndex((frame) => frame.type === 'compaction_end');
  ok(start < end && end < compact, 'compact ordering is start, end, response');
  ok(frames[start].requestId === frames[end].requestId && frames[start].requestId !== 'compact-r1', 'compaction events use distinct provider requestId');
  ok(frames[compact].id === 'compact-r1' && frames[compact].success === false, 'compact response echoes RPC id and reports mock error');
}

// Automatic compaction uses a provider-defined reason rather than a synthetic auto value.
{
  const mock = runMock({ MOCK_PI_AUTO_COMPACT: '1' });
  const compacted = mock.waitFor((frame) => frame.type === 'compaction_end', 'automatic compaction end');
  mock.send({ type: 'prompt', message: 'hello', id: 'auto-compact-1' });
  const frame = await compacted;
  const manual = mock.waitFor(
    (candidate) => candidate.type === 'compaction_end' && candidate.requestId === 'compact-provider-2',
    'manual compact end',
  );
  mock.send({ type: 'compact', id: 'manual-compact-1' });
  const manualEnd = await manual;
  await mock.close();
  ok(frame.reason === 'threshold' || frame.reason === 'overflow', 'automatic compaction uses threshold or overflow reason');
  const manualStart = mock.frames.find(
    (candidate) => candidate.type === 'compaction_start' && candidate.requestId === 'compact-provider-2',
  );
  ok(manualStart?.reason === 'manual' && manualEnd.reason === 'manual', 'manual compact lifecycle uses manual reason with auto compaction enabled');
}

// A delayed compact A response and duplicate A end arrive only after compact B
// starts, leaving B deliberately active for consumer correlation tests.
{
  const mock = runMock({ MOCK_PI_COMPACT_STALE_A_SCENARIO: '1' });
  const firstEnd = mock.waitFor((frame) => frame.type === 'compaction_end', 'compact A end');
  mock.send({ type: 'compact', id: 'compact-a' });
  await firstEnd;
  const secondStart = mock.waitFor(
    (frame) => frame.type === 'compaction_start' && frame.requestId === 'compact-provider-2',
    'compact B start',
  );
  const delayedA = mock.waitFor(
    (frame) => frame.type === 'response' && frame.id === 'compact-a',
    'delayed compact A response',
  );
  mock.send({ type: 'compact', id: 'compact-b' });
  await Promise.all([secondStart, delayedA]);
  await mock.close();
  const bEnds = mock.frames.filter(
    (frame) => frame.type === 'compaction_end' && frame.requestId === 'compact-provider-2',
  );
  ok(bEnds.length === 0, 'stale-A scenario leaves compact B active after delayed A response');
  ok(!mock.frames.some((frame) => frame.type === 'response' && frame.id === 'compact-b'), 'compact B response remains pending');
}

// Command invalidation is deterministic and changes the subsequent inventory.
{
  const mock = runMock();
  const changed = mock.waitFor((frame) => frame.type === 'commands_changed', 'commands_changed');
  mock.send({ type: 'mock_commands_changed', count: 3, id: 'change-1' });
  const changedFrame = await changed;
  const commands = mock.waitFor((frame) => frame.command === 'get_commands', 'changed commands');
  mock.send({ type: 'get_commands', id: 'changed-get' });
  const listed = await commands;
  await mock.close();
  ok(listed.data.commands.length === 3, 'commands_changed control mutates command inventory');
  ok(Array.isArray(changedFrame.commands) && changedFrame.commands.length === 3 && JSON.stringify(changedFrame.commands) === JSON.stringify(listed.data.commands), 'commands_changed carries the updated commands array directly');
}

// Omo extension-local prompts have invocation metadata but no agent lifecycle.
{
  const local = runMock({ MOCK_PI_LOCAL_PROMPT: '1' });
  const response = local.waitFor((frame) => frame.command === 'prompt', 'local prompt response');
  local.send({ type: 'prompt', message: '/help', id: 'local-1' });
  const responseFrame = await response;
  await local.close();
  const types = local.frames.map((frame) => frame.type);
  ok(types.join(',') === 'command_invocation,response', 'local prompt exact frame sequence');
  ok(local.frames[0].command.name === 'help' && local.frames[0].command.source === 'extension', 'local invocation identifies extension source');
  ok(responseFrame.data === undefined && responseFrame.success === true, 'local response succeeds without data');
  ok(!types.includes('agent_start') && !types.includes('agent_end') && !types.includes('agent_settled'), 'local prompt has no agent lifecycle');
}

// Omo provider-initiated wake turns have a lifecycle without a prompt RPC.
{
  const wake = runMock({ MOCK_PI_WAKE_TURN: '1', MOCK_PI_CHUNKS: '1' });
  const settled = wake.waitFor((frame) => frame.type === 'agent_settled', 'wake turn settled');
  wake.send({ type: 'mock_wake_turn' });
  await settled;
  await wake.close();
  const types = wake.frames.map((frame) => frame.type);
  ok(types[0] === 'agent_start' && types.at(-1) === 'agent_settled', 'wake turn starts and settles without response');
  ok(types.includes('message_start') && types.includes('message_end') && types.includes('agent_end'), 'wake turn emits message and end frames');
  ok(!types.includes('response'), 'wake turn has no inbound prompt response');
}

// ---- Multi-session mode (--multi-session) ----

// Control plane: protocol info, open/list/close lifecycle, and sessionId enforcement.
{
  const mock = runMock({}, ['--multi-session']);
  const info = mock.waitFor((frame) => frame.command === 'get_protocol_info', 'get_protocol_info response');
  mock.send({ type: 'get_protocol_info', id: 'p1' });
  const infoFrame = await info;
  ok(infoFrame.data.protocolVersion === 1 && infoFrame.data.mode === 'multi' && infoFrame.data.serverVersion === 'mock', 'get_protocol_info reports multi mode');
  ok(Array.isArray(infoFrame.data.capabilities) && infoFrame.data.capabilities.includes('multi_session') && infoFrame.data.capabilities.includes('extension_events'), 'capabilities include multi_session and extension_events');

  const missing = mock.waitFor((frame) => frame.error === 'missing_session_id', 'missing_session_id rejection');
  mock.send({ type: 'get_state', id: 'nosession' });
  ok((await missing).success === false, 'session-scoped command without sessionId is rejected');

  const openA = mock.waitFor((frame) => frame.command === 'open_session' && frame.sessionId === 'rpc-1', 'open A');
  const openB = mock.waitFor((frame) => frame.command === 'open_session' && frame.sessionId === 'rpc-2', 'open B');
  mock.send({ type: 'open_session', cwd: '/tmp/mock-a', id: 'oa' });
  mock.send({ type: 'open_session', sessionPath: '/tmp/resume.json', id: 'ob' });
  const [frameA, frameB] = await Promise.all([openA, openB]);
  ok(frameA.data.sessionId === 'rpc-1' && frameA.data.state.sessionId && frameA.data.state.sessionId !== 'rpc-1', 'open_session returns ephemeral handle plus durable state.sessionId');
  ok(/^[0-9a-f-]{36}$/.test(frameA.data.state.sessionId), 'durable session id is a uuid');
  ok(frameA.data.state.model?.id === 'mock-model', 'open_session state carries the model');
  ok(frameB.data.state.sessionId !== frameA.data.state.sessionId, 'durable session ids differ across opens');

  const listed = mock.waitFor((frame) => frame.command === 'list_sessions' && frame.data.sessions.length === 2, 'list with two sessions');
  mock.send({ type: 'list_sessions', id: 'l1' });
  const listFrame = await listed;
  ok(listFrame.data.sessions.map((session) => session.sessionId).join(',') === 'rpc-1,rpc-2', 'list_sessions enumerates open handles');
  ok(listFrame.data.sessions.every((session) => session.durableSessionId && session.status === 'idle'), 'list_sessions carries durable ids and idle status');
  ok(listFrame.data.sessions[0].cwd === '/tmp/mock-a' && listFrame.data.sessions[1].sessionPath === '/tmp/resume.json', 'list_sessions echoes cwd and sessionPath');

  const closed = mock.waitFor((frame) => frame.command === 'close_session', 'close response');
  mock.send({ type: 'close_session', sessionId: 'rpc-1', id: 'c1' });
  const closeFrame = await closed;
  ok(closeFrame.success === true && closeFrame.sessionId === 'rpc-1', 'close_session echoes the handle');
  const after = mock.waitFor((frame) => frame.command === 'list_sessions' && frame.id === 'l2', 'list after close');
  mock.send({ type: 'list_sessions', id: 'l2' });
  ok((await after).data.sessions.length === 1, 'closed handle disappears from list_sessions');
  const rejected = mock.waitFor((frame) => frame.success === false && frame.error === 'unknown_session', 'closed-handle rejection');
  mock.send({ type: 'close_session', sessionId: 'rpc-1', id: 'c2' });
  ok((await rejected).command === 'close_session', 'commands for a closed handle are rejected as unknown_session');
  await mock.close();
}

// Session scoping: every frame carries a routing handle and per-session state stays isolated.
{
  const mock = runMock({ MOCK_PI_CHUNKS: '1', MOCK_PI_RESUME_CONTRACT: join(tmpdir(), 'mock-pi-multisession-history.json') }, ['--multi-session']);
  const openA = mock.waitFor((frame) => frame.command === 'open_session' && frame.sessionId === 'rpc-1', 'open A');
  const openB = mock.waitFor((frame) => frame.command === 'open_session' && frame.sessionId === 'rpc-2', 'open B');
  mock.send({ type: 'open_session', id: 'oa' });
  mock.send({ type: 'open_session', id: 'ob' });
  const [frameA] = await Promise.all([openA, openB]);
  const settledA = mock.waitFor((frame) => frame.type === 'agent_settled' && frame.sessionId === 'rpc-1', 'A settled');
  const settledB = mock.waitFor((frame) => frame.type === 'agent_settled' && frame.sessionId === 'rpc-2', 'B settled');
  mock.send({ type: 'prompt', message: 'alpha', sessionId: 'rpc-1', id: 'pa' });
  mock.send({ type: 'prompt', message: 'beta', sessionId: 'rpc-2', id: 'pb' });
  await Promise.all([settledA, settledB]);

  ok(mock.frames.every((frame) => frame.sessionId === 'rpc-1' || frame.sessionId === 'rpc-2'), 'every multi-mode frame is tagged with a routing handle');
  const aFrames = mock.frames.filter((frame) => frame.sessionId === 'rpc-1');
  const bFrames = mock.frames.filter((frame) => frame.sessionId === 'rpc-2');
  ok(aFrames.find((frame) => frame.type === 'turn_end').message.content[0].text.includes('alpha'), 'session A streamed its own prompt text');
  ok(bFrames.find((frame) => frame.type === 'turn_end').message.content[0].text.includes('beta'), 'session B streamed its own prompt text');
  ok(!aFrames.some((frame) => JSON.stringify(frame).includes('beta')) && !bFrames.some((frame) => JSON.stringify(frame).includes('alpha')), 'session frames never leak the other session text');

  const stateA = mock.waitFor((frame) => frame.command === 'get_state' && frame.sessionId === 'rpc-1', 'A state');
  const entriesB = mock.waitFor((frame) => frame.command === 'get_entries' && frame.sessionId === 'rpc-2', 'B entries');
  const entriesA = mock.waitFor((frame) => frame.command === 'get_entries' && frame.sessionId === 'rpc-1', 'A entries');
  mock.send({ type: 'get_state', sessionId: 'rpc-1', id: 'sa' });
  mock.send({ type: 'get_entries', sessionId: 'rpc-2', id: 'eb' });
  mock.send({ type: 'get_entries', sessionId: 'rpc-1', id: 'ea' });
  const [stateFrame, entriesFrameB, entriesFrameA] = await Promise.all([stateA, entriesB, entriesA]);
  ok(stateFrame.data.sessionId === frameA.data.state.sessionId, 'get_state returns the durable session id');
  ok(entriesFrameB.data.entries.some((entry) => JSON.stringify(entry).includes('beta')) && !entriesFrameB.data.entries.some((entry) => JSON.stringify(entry).includes('alpha')), 'B history holds only its own prompt');
  ok(entriesFrameA.data.entries.some((entry) => JSON.stringify(entry).includes('alpha')) && !entriesFrameA.data.entries.some((entry) => JSON.stringify(entry).includes('beta')), 'A history holds only its own prompt');
  await mock.close();
  try { unlinkSync(join(tmpdir(), 'mock-pi-multisession-history.json')); } catch { /* already gone */ }
}

// Signal-mode gating, abort, and close are routed per sessionId in isolation.
{
  const mock = runMock({ MOCK_PI_CHUNK_MODE: 'signal', MOCK_PI_CHUNKS: '2' }, ['--multi-session']);
  mock.send({ type: 'open_session', id: 'oa' });
  mock.send({ type: 'open_session', id: 'ob' });
  await Promise.all([
    mock.waitFor((frame) => frame.command === 'open_session' && frame.sessionId === 'rpc-1', 'open A'),
    mock.waitFor((frame) => frame.command === 'open_session' && frame.sessionId === 'rpc-2', 'open B'),
  ]);
  mock.send({ type: 'prompt', message: 'longlonglong-a', sessionId: 'rpc-1', id: 'pa' });
  mock.send({ type: 'prompt', message: 'longlonglong-b', sessionId: 'rpc-2', id: 'pb' });
  await Promise.all([
    mock.waitFor((frame) => frame.type === 'message_update' && frame.assistantMessageEvent?.type === 'text_delta' && frame.sessionId === 'rpc-1', 'A first delta'),
    mock.waitFor((frame) => frame.type === 'message_update' && frame.assistantMessageEvent?.type === 'text_delta' && frame.sessionId === 'rpc-2', 'B first delta'),
  ]);

  mock.send({ type: 'mock_chunk_next', sessionId: 'rpc-2', id: 'nb' });
  await mock.waitFor((frame) => frame.type === 'agent_settled' && frame.sessionId === 'rpc-2', 'B settled');
  ok(!mock.frames.some((frame) => frame.type === 'agent_settled' && frame.sessionId === 'rpc-1'), 'A stays gated while only B is released');

  mock.send({ type: 'abort', sessionId: 'rpc-1', id: 'ab' });
  await mock.waitFor((frame) => frame.type === 'agent_settled' && frame.sessionId === 'rpc-1', 'A settled after abort');
  ok(mock.frames.filter((frame) => frame.sessionId === 'rpc-1' && frame.type === 'message_end').at(-1).message.stopReason === 'aborted', 'aborted session ends with stopReason aborted');
  ok(mock.frames.filter((frame) => frame.sessionId === 'rpc-2' && frame.type === 'message_end').at(-1).message.stopReason === 'stop', 'the other session completed normally');

  // Close mid-turn: the close response is the last record tagged with the handle.
  mock.send({ type: 'prompt', message: 'late', sessionId: 'rpc-1', id: 'pc' });
  await mock.waitFor((frame) => frame.type === 'message_update' && frame.assistantMessageEvent?.type === 'text_delta' && frame.sessionId === 'rpc-1' && frame.assistantMessageEvent.delta.startsWith('late'), 'late A delta');
  const before = mock.frames.filter((frame) => frame.sessionId === 'rpc-1').length;
  mock.send({ type: 'close_session', sessionId: 'rpc-1', id: 'cc' });
  await mock.waitFor((frame) => frame.success === true && frame.command === 'close_session', 'close response');
  mock.send({ type: 'mock_chunk_next', sessionId: 'rpc-1', id: 'na' });
  const rejected = await mock.waitFor((frame) => frame.success === false && frame.error === 'unknown_session', 'post-close rejection');
  ok(rejected.command === 'mock_chunk_next', 'chunk_next for a closed handle is rejected');
  const tagged = mock.frames.filter((frame) => frame.sessionId === 'rpc-1');
  ok(tagged.length === before + 1 && tagged.at(-1).command === 'close_session', 'close response is the last frame tagged with the closed handle');
  await mock.close();
}

// Approval requests and commands_changed broadcasts are tagged per session.
{
  const mock = runMock({ MOCK_PI_APPROVE: '1', MOCK_PI_CHUNKS: '1' }, ['--multi-session']);
  mock.send({ type: 'open_session', id: 'oa' });
  mock.send({ type: 'open_session', id: 'ob' });
  await Promise.all([
    mock.waitFor((frame) => frame.command === 'open_session' && frame.sessionId === 'rpc-1', 'open A'),
    mock.waitFor((frame) => frame.command === 'open_session' && frame.sessionId === 'rpc-2', 'open B'),
  ]);
  const approval = mock.waitFor((frame) => frame.type === 'extension_ui_request' && frame.sessionId === 'rpc-1', 'A approval request');
  mock.send({ type: 'prompt', message: 'do a thing', sessionId: 'rpc-1', id: 'pa' });
  const request = await approval;
  ok(request.id === 'approve-1' && request.options?.length === 2, 'approval request keeps deterministic per-session shape');

  const changedA = mock.waitFor((frame) => frame.type === 'commands_changed' && frame.sessionId === 'rpc-1', 'A commands_changed');
  const changedB = mock.waitFor((frame) => frame.type === 'commands_changed' && frame.sessionId === 'rpc-2', 'B commands_changed');
  // The ack is written after both broadcasts, so awaiting it guarantees the
  // whole exchange is in the frame buffer before any filtering below.
  const ack = mock.waitFor((frame) => frame.command === 'mock_commands_changed', 'commands ack');
  mock.send({ type: 'mock_commands_changed', count: 2, sessionId: 'rpc-1', id: 'mc' });
  const [changedFrameA, changedFrameB, ackFrame] = await Promise.all([changedA, changedB, ack]);
  ok(changedFrameA.commands.length === 2 && changedFrameB.commands.length === 2, 'commands_changed broadcasts to every open session');
  const acks = mock.frames.filter((frame) => frame.command === 'mock_commands_changed');
  ok(acks.length === 1 && acks[0].sessionId === 'rpc-1' && acks[0].data.generation === 1, 'mock_commands_changed acks only the requesting session with a dedicated inventory generation');

  const settled = mock.waitFor((frame) => frame.type === 'agent_settled' && frame.sessionId === 'rpc-1', 'A settled');
  mock.send({ type: 'extension_ui_response', id: request.id, value: 'Allow', sessionId: 'rpc-1' });
  await settled;
  ok(mock.frames.some((frame) => frame.sessionId === 'rpc-1' && frame.type === 'message_update' && frame.assistantMessageEvent?.type === 'text_delta'), 'approval response routes by sessionId and streams');
  ok(!mock.frames.some((frame) => frame.type === 'agent_settled' && frame.sessionId === 'rpc-2'), 'the idle session never sees the other session turn');
  await mock.close();
}

console.log(`mock-pi tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
