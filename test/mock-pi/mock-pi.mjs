#!/usr/bin/env node
// allow: SIZE_OK — deterministic provider protocol fixture kept as one readable script for hermetic QA.
// mock-pi — a deterministic fake `pi --mode rpc` for omo-webchat hermetic tests.
// Speaks the pi RPC JSONL protocol (LF-only framing, never splits on U+2028/U+2029).
// Configurable via env:
//   MOCK_PI_TEXT       full assistant text to stream (default: echoes prompt + fixed suffix)
//   MOCK_PI_CHUNKS     number of text_delta chunks (default 4)
//   MOCK_PI_CHUNK_MODE "signal" to require mock_chunk_next between chunks (abort also releases)
//   MOCK_PI_UNICODE    "1" to include a U+2028 char inside a chunk (framing stress)
//   MOCK_PI_APPROVE    "1" to emit an extension_ui_request select before streaming (approval path)
//   MOCK_PI_TOOL       "1" to emit a tool_execution sequence (bash) during the turn
//   MOCK_PI_HOOK       "1" to emit and persist Omo task hook messages
//   MOCK_PI_EXT_EVENT  "1" to emit extension_events each turn (valid omo.task.updated + omo.dag.updated, plus a nameless malformed)
//   MOCK_PI_COMMANDS     number of commands to advertise (default provider set)
//   MOCK_PI_USAGE      JSON object merged into message usage (default {})
//   MOCK_PI_LOCAL_PROMPT "1" to complete an extension-local prompt without invoking the agent
//   MOCK_PI_WAKE_TURN "1" to enable the Omo-only mock_wake_turn control
//   MOCK_PI_COMPACT_STALE_A_SCENARIO "1" to hold A's response until B starts
//   MOCK_PI_SWITCH_FAIL "1" to reject switch_session
//   MOCK_PI_HOLD       "1" to keep a prompt in-flight until abort (detached runtime QA)
//   MOCK_PI_HOLD_MS    milliseconds before a held prompt completes (default 500)
//   MOCK_PI_RESUME_CONTRACT path to persist history across process restarts
//   MOCK_PI_RESUME_IDENTITY exact identity used by that restart contract
//
// Multi-session mode (omo `--mode rpc --multi-session`):
//   node mock-pi.mjs --multi-session
//   Mode is fixed at process start by the presence of --multi-session in argv;
//   without the flag the mock behaves exactly like classic single-session mode
//   (one implicit session, no sessionId tagging, no control commands).
//   Control commands (no sessionId): get_protocol_info, open_session, close_session,
//   list_sessions. open_session returns an ephemeral routing handle "rpc-N" (also in
//   the top-level sessionId of every frame for that session) plus a durable uuid in
//   state.sessionId. Every other command REQUIRES a top-level sessionId equal to the
//   routing handle; a session-scoped command without one is rejected with
//   error "missing_session_id", and frames for a closed handle stop immediately
//   (the close_session response is the last record tagged with that handle).
//
// Usage as a pi stand-in:
//   node mock-pi.mjs                          # behaves like `pi --mode rpc`
//   ln -s mock-pi.mjs pi && ./pi --mode rpc   # argv-compatible

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

const LOG_FILE = process.env.MOCK_PI_LOG || '';
const JSON_LOG_FILE = process.env.MOCK_PI_LOG_JSON || '';
const MULTI_SESSION = process.argv.includes('--multi-session');
const CHUNKS = Math.max(1, parseInt(process.env.MOCK_PI_CHUNKS || '4', 10));
const CHUNK_MODE = process.env.MOCK_PI_CHUNK_MODE === 'signal' ? 'signal' : 'turn';
const USE_UNICODE = process.env.MOCK_PI_UNICODE === '1';
const DO_APPROVE = process.env.MOCK_PI_APPROVE === '1';
const DO_TOOL = process.env.MOCK_PI_TOOL === '1';
const DO_HOOK = process.env.MOCK_PI_HOOK === '1';
const DO_EXT_EVENT = process.env.MOCK_PI_EXT_EVENT === '1';
const TOOL_COMMAND = process.env.MOCK_PI_TOOL_COMMAND || 'echo hi';
const TOOL_TEXT = process.env.MOCK_PI_TOOL_TEXT ?? 'hi\n';
const DO_LOCAL_PROMPT = process.env.MOCK_PI_LOCAL_PROMPT === '1';
const DO_WAKE_TURN = process.env.MOCK_PI_WAKE_TURN === '1';
const HOLD_PROMPT = process.env.MOCK_PI_HOLD === '1';
const HOLD_MS = Math.max(0, parseInt(process.env.MOCK_PI_HOLD_MS || '500', 10));
const COMMAND_COUNT = Math.max(0, parseInt(process.env.MOCK_PI_COMMANDS || '0', 10));
const MOCK_COMPACT_ERROR = process.env.MOCK_PI_COMPACT_ERROR || '';
const COMPACT_DELAY_MS = Math.max(0, parseInt(process.env.MOCK_PI_COMPACT_DELAY_MS || '0', 10));
const COMPACT_STALE_RESPONSE = process.env.MOCK_PI_COMPACT_STALE_RESPONSE === '1';
const COMPACT_MISMATCH_REQUEST_ID = process.env.MOCK_PI_COMPACT_MISMATCH_REQUEST_ID === '1';
const COMPACT_DUPLICATE_REQUEST_ID = process.env.MOCK_PI_COMPACT_DUPLICATE_REQUEST_ID === '1';
const COMPACT_STALE_A_SCENARIO = process.env.MOCK_PI_COMPACT_STALE_A_SCENARIO === '1';
const AUTO_COMPACT = process.env.MOCK_PI_AUTO_COMPACT === '1';
const FAIL_SWITCH = process.env.MOCK_PI_SWITCH_FAIL === '1';
const RESUME_CONTRACT_FILE = process.env.MOCK_PI_RESUME_CONTRACT || '';
const RESUME_IDENTITY = process.env.MOCK_PI_RESUME_IDENTITY || '';
const HISTORY_SIZE = Math.max(0, parseInt(process.env.MOCK_PI_HISTORY_SIZE || '0', 10));
let USAGE = {};
try { USAGE = JSON.parse(process.env.MOCK_PI_USAGE || '{}'); } catch { USAGE = {}; }

// ---- LF-only JSONL stdout writer (exactly one \n per frame) ----
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// Session-aware emit: single-session frames pass through untouched; multi-session
// frames are tagged with the routing handle and dropped once the session is closed.
function emit(S, obj) {
  if (!MULTI_SESSION) { send(obj); return; }
  if (S.closed) return;
  send({ ...obj, sessionId: S.handle });
}

function logCommand(command) {
  if (LOG_FILE) fs.appendFileSync(LOG_FILE, (command.type || 'unknown') + '\n');
  if (JSON_LOG_FILE) fs.appendFileSync(JSON_LOG_FILE, JSON.stringify(command) + '\n');
}

function command(name, description, source = 'extension', path = '<builtin:mock>') {
  const skill = source === 'skill';
  return { name, description, sourceInfo: { path, source: 'cli', scope: 'temporary', origin: 'top-level', baseDir: '/mock/base' }, source, syntax: skill ? 'dollar' : 'slash' };
}
let commandInventory = COMMAND_COUNT > 0
  ? Array.from({ length: COMMAND_COUNT }, (_, i) => command(`command-${String(i + 1).padStart(2, '0')}`, `Command ${i + 1}`))
  : [command('fix-tests', 'Fix failing tests'), command('skill:demo', 'Demo skill', 'skill', '<skill:demo>')];
function omoCommands() { return commandInventory; }

// ---- Per-session runtime state ----
// Single-session mode runs on one implicit session whose frames are never tagged;
// multi-session mode keeps one state per open routing handle.
function createSessionState() {
  const state = {
    handle: null,           // ephemeral routing handle "rpc-N"; null in single mode
    durableSessionId: null, // stable uuid surfaced in state payloads (multi mode)
    sessionPath: null,
    cwd: process.cwd(),
    closed: false,
    streaming: false,
    aborted: false,
    holdActive: false,
    holdGeneration: 0,
    releaseChunk: undefined,
    approvalSequence: 0,
    pendingApprovals: new Map(),
    compactGeneration: 0,   // provider compaction request ids ("compact-provider-N")
    commandsGeneration: 0,  // command-inventory generation reported by mock_commands_changed
    compactSequence: 0,
    delayedCompactResponse: undefined,
    contractHistory: [],
    activeResumeIdentity: RESUME_IDENTITY,
  };
  for (let i = 0; i < HISTORY_SIZE; i++) {
    state.contractHistory.push({ role: 'user', content: [{ type: 'text', text: `history user turn ${i}` }] });
    state.contractHistory.push({ role: 'assistant', content: [{ type: 'text', text: `history assistant reply ${i}` }] });
  }
  return state;
}
const implicitSession = createSessionState();
const sessions = new Map(); // routing handle -> session state (multi mode only)
let nextSessionNumber = 0;

function allSessions() {
  return MULTI_SESSION ? [...sessions.values()] : [implicitSession];
}

// ---- LF-only stdin line reader (NOT readline: must not split on U+2028/U+2029) ----
let buf = '';
function handleCommand(cmd) {
  logCommand(cmd);
  if (!MULTI_SESSION) {
    try { onCommand(implicitSession, cmd); }
    catch (err) { send({ type: 'response', command: cmd?.type || 'parse', success: false, error: String(err && err.message || err), id: cmd?.id ?? undefined }); }
    return;
  }
  switch (cmd.type) {
    case 'get_protocol_info':
      send({ type: 'response', command: 'get_protocol_info', success: true, id: cmd.id, data: { protocolVersion: 1, serverVersion: 'mock', capabilities: ['multi_session', 'extension_events'], mode: 'multi' } });
      return;
    case 'open_session': {
      const handle = `rpc-${++nextSessionNumber}`;
      const session = createSessionState();
      session.handle = handle;
      session.durableSessionId = randomUUID();
      if (typeof cmd.cwd === 'string' && cmd.cwd) session.cwd = cmd.cwd;
      if (typeof cmd.sessionPath === 'string' && cmd.sessionPath) session.sessionPath = cmd.sessionPath;
      sessions.set(handle, session);
      send({ type: 'response', command: 'open_session', success: true, sessionId: handle, id: cmd.id, data: { sessionId: handle, state: rpcSessionState(session) } });
      return;
    }
    case 'close_session': {
      const session = typeof cmd.sessionId === 'string' ? sessions.get(cmd.sessionId) : undefined;
      if (!session) {
        send({ type: 'response', command: 'close_session', success: false, error: 'unknown_session', id: cmd.id });
        return;
      }
      session.closed = true;
      session.aborted = true;
      unblockChunk(session);
      sessions.delete(cmd.sessionId);
      send({ type: 'response', command: 'close_session', success: true, sessionId: cmd.sessionId, id: cmd.id });
      return;
    }
    case 'list_sessions':
      send({ type: 'response', command: 'list_sessions', success: true, id: cmd.id, data: { sessions: [...sessions.values()].map((session) => ({ sessionId: session.handle, durableSessionId: session.durableSessionId, sessionPath: session.sessionPath, cwd: session.cwd, status: session.streaming || session.holdActive ? 'streaming' : 'idle' })) } });
      return;
    default: {
      if (typeof cmd.sessionId !== 'string' || cmd.sessionId === '') {
        send({ type: 'response', command: cmd.type || 'parse', success: false, error: 'missing_session_id', id: cmd.id });
        return;
      }
      const session = sessions.get(cmd.sessionId);
      if (!session) {
        send({ type: 'response', command: cmd.type || 'parse', success: false, error: 'unknown_session', id: cmd.id });
        return;
      }
      try { onCommand(session, cmd); }
      catch (err) { emit(session, { type: 'response', command: cmd.type || 'parse', success: false, error: String(err && err.message || err), id: cmd.id }); }
    }
  }
}

// Read raw bytes; split ONLY on \n; strip a single trailing \r.
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl = buf.indexOf('\n');
  while (nl !== -1) {
    let line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    nl = buf.indexOf('\n');
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length === 0) continue;
    let cmd;
    try { cmd = JSON.parse(line); }
    catch (e) { send({ type: 'response', command: 'parse', success: false, error: 'Failed to parse command: ' + e.message }); continue; }
    handleCommand(cmd);
  }
});
process.stdin.on('end', () => { process.exit(0); });

function advanceChunk(S) {
  if (CHUNK_MODE === 'turn') return new Promise((resolve) => setImmediate(resolve));
  return new Promise((resolve) => { S.releaseChunk = resolve; });
}

function unblockChunk(S) {
  if (!S.releaseChunk) return;
  const resolve = S.releaseChunk;
  S.releaseChunk = undefined;
  resolve();
}

function rpcSessionState(S) {
  const identity = RESUME_IDENTITY
    ? { sessionFile: S.activeResumeIdentity, sessionId: MULTI_SESSION ? S.durableSessionId : 'dummy-omo-session-id' }
    : { sessionId: MULTI_SESSION ? S.durableSessionId : 'mock-omo-session' };
  return { model: { id: 'mock-model', name: 'Mock', provider: 'mock', contextWindow: 200000, maxTokens: 4096 }, thinkingLevel: 'medium', isStreaming: S.holdActive, isCompacting: false, ...identity, sessionName: 'mock', autoCompactionEnabled: true, messageCount: S.contractHistory.length, pendingMessageCount: 0 };
}

async function streamTurn(S, userMessage, injectedMessage = null) {
  S.streaming = true;
  try {
    // Optional approval gate (simulates an extension requesting consent).
    if (DO_APPROVE) {
      const approveId = `approve-${++S.approvalSequence}`;
      emit(S, { type: 'extension_ui_request', id: approveId, method: 'select', title: 'Allow ' + (DO_TOOL ? 'bash' : 'action') + '?', options: ['Allow', 'Block'] });
      const decision = await new Promise((resolve) => { S.pendingApprovals.set(approveId, { resolve }); });
      if (decision.cancelled || /block/i.test(String(decision.value || ''))) {
        // Extension declined: end the turn without streaming.
        emit(S, { type: 'agent_start' });
        emit(S, { type: 'turn_start' });
        emit(S, { type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text: '[blocked by user]' }] }, toolResults: [] });
        emit(S, { type: 'agent_end', messages: [], willRetry: false });
        emit(S, { type: 'agent_settled' });
        return;
      }
    }

    // Build the text to stream.
    const suffix = ' (mocked by mock-pi)';
    let text = process.env.MOCK_PI_TEXT != null ? process.env.MOCK_PI_TEXT : (userMessage + suffix);
    if (USE_UNICODE) text += '\u2028'; // LINE SEPARATOR inside content — must survive framing
    const hookMessages = DO_HOOK ? [
      {
        customType: 'senpi-task.usage',
        content: '<omo-senpi-task>\nBackground task results are automatically delivered.\n</omo-senpi-task>',
        timestamp: Date.now(),
      },
      {
        customType: 'omo-senpi:wake',
        content: 'task completion name:st_mock id:st_mock category:quick status:completed\nresult:"quick category agent responded"',
        timestamp: Date.now() + 1,
      },
    ] : [];

    emit(S, { type: 'agent_start' });
    emit(S, { type: 'turn_start' });
    if (DO_EXT_EVENT) {
      // Valid extension event: the backend must forward it verbatim to WS clients
      // (omo only emits these to RPC clients advertising the extension_events capability).
      emit(S, { type: 'extension_event', name: 'omo.task.updated', data: { task: { id: 'st_mock_001', name: 'st_mock', title: 'Quick category agent', status: 'running', category: 'quick' } } });
      // Second snapshot event: the backend caches the latest of this pair and
      // replays both to clients attaching after the turn.
      emit(S, { type: 'extension_event', name: 'omo.dag.updated', data: { dag: { nodes: [{ id: 'st_mock_001', status: 'running' }], edges: [] } } });
      // Malformed: no name — the backend must drop it, not crash the session.
      emit(S, { type: 'extension_event' });
    }
    if (injectedMessage) hookMessages.unshift({ ...injectedMessage, timestamp: Date.now() });
    for (const hook of hookMessages) {
      const message = { role: 'custom', ...hook, display: false, details: {} };
      emit(S, { type: 'message_start', message });
      emit(S, { type: 'message_end', message });
    }
    emit(S, { type: 'message_start', message: { role: 'assistant', content: [], provider: 'mock', model: 'mock-model', usage: USAGE } });

    if (DO_TOOL) {
      emit(S, { type: 'message_update', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call_mock', name: 'bash', arguments: { command: TOOL_COMMAND } }] }, assistantMessageEvent: { type: 'toolcall_end', toolCall: { id: 'call_mock', name: 'bash', arguments: { command: TOOL_COMMAND } } } });
      emit(S, { type: 'tool_execution_start', toolCallId: 'call_mock', toolName: 'bash', args: { command: TOOL_COMMAND } });
      emit(S, { type: 'tool_execution_update', toolCallId: 'call_mock', toolName: 'bash', args: { command: TOOL_COMMAND }, partialResult: { content: [{ type: 'text', text: TOOL_TEXT }] } });
      emit(S, { type: 'tool_execution_end', toolCallId: 'call_mock', toolName: 'bash', result: { content: [{ type: 'text', text: TOOL_TEXT }] }, isError: false });
      emit(S, { type: 'message_end', message: { role: 'toolResult', toolCallId: 'call_mock', toolName: 'bash', content: [{ type: 'text', text: TOOL_TEXT }], isError: false } });
    }

    // Stream text in CHUNKS pieces.
    const pieceLen = Math.max(1, Math.ceil(text.length / CHUNKS));
    emit(S, { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: '' }] }, assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: { type: 'text', text: '' } } });
    let acc = '';
    for (let i = 0; i < text.length; i += pieceLen) {
      if (S.aborted) break;
      const piece = text.slice(i, i + pieceLen);
      acc += piece;
      emit(S, { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: acc }] }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: piece, partial: { type: 'text', text: acc } } });
      if (i + pieceLen < text.length) await advanceChunk(S);
    }
    const stopReason = S.aborted ? 'aborted' : 'stop';
    emit(S, { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: acc }] }, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: acc, partial: { type: 'text', text: acc } } });
    const finalMessage = { role: 'assistant', content: [{ type: 'text', text: acc }], provider: 'mock', model: 'mock-model', usage: USAGE, stopReason };
    emit(S, { type: 'message_end', message: finalMessage });
    emit(S, { type: 'turn_end', message: finalMessage, toolResults: [] });
    if (RESUME_CONTRACT_FILE) {
      const restoredToolMessages = DO_TOOL ? [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call_mock', name: 'bash', arguments: { command: TOOL_COMMAND } }],
          provider: 'mock',
          model: 'mock-model',
          usage: USAGE,
          stopReason: 'toolUse',
        },
        {
          role: 'toolResult',
          toolCallId: 'call_mock',
          toolName: 'bash',
          content: [{ type: 'text', text: TOOL_TEXT }],
          isError: false,
        },
      ] : [];
      S.contractHistory = [
        ...hookMessages.map((hook) => ({
          type: 'custom_message',
          customType: hook.customType,
          content: hook.content,
          display: false,
          timestamp: new Date(hook.timestamp).toISOString(),
        })),
        { role: 'user', content: [{ type: 'text', text: userMessage }] },
        ...restoredToolMessages,
        finalMessage,
      ];
      fs.writeFileSync(RESUME_CONTRACT_FILE, JSON.stringify({ identity: S.activeResumeIdentity, history: S.contractHistory }));
    }
    emit(S, { type: 'agent_end', messages: [finalMessage], willRetry: false });
    emit(S, { type: 'agent_settled' });
  } finally {
    S.streaming = false;
  }
}

function wakeTurn(S) {
  S.aborted = false;
  streamTurn(S, 'Omo wake turn', { customType: 'omo-wake-turn', content: 'provider initiated wake turn' });
}

function onCommand(S, cmd) {
  switch (cmd.type) {
    case 'prompt': {
      if (HOLD_PROMPT) {
        emit(S, { type: 'response', command: 'prompt', success: true, id: cmd.id });
        emit(S, { type: 'agent_start' });
        emit(S, { type: 'turn_start' });
        S.holdActive = true;
        const generation = ++S.holdGeneration;
        S.contractHistory = [{ role: 'user', content: [{ type: 'text', text: cmd.message || '' }] }];
        setTimeout(() => {
          if (!S.holdActive || generation !== S.holdGeneration) return;
          const message = { role: 'assistant', content: [{ type: 'text', text: 'completed while detached' }], provider: 'mock', model: 'mock-model', usage: USAGE, stopReason: 'stop' };
          S.contractHistory = [...S.contractHistory, message];
          S.holdActive = false;
          emit(S, { type: 'message_end', message });
          emit(S, { type: 'turn_end', message, toolResults: [] });
          emit(S, { type: 'agent_end', messages: [message], willRetry: false });
          emit(S, { type: 'agent_settled' });
        }, HOLD_MS);
        return;
      }
      if (DO_LOCAL_PROMPT) {
        emit(S, { type: 'command_invocation', command: { name: cmd.message.slice(1), source: 'extension' } });
        emit(S, { type: 'response', command: 'prompt', success: true, id: cmd.id });
        return;
      }
      emit(S, { type: 'response', command: 'prompt', success: true, id: cmd.id });
      if (AUTO_COMPACT) {
        const requestId = `compact-provider-${++S.compactGeneration}`;
        emit(S, { type: 'compaction_start', reason: 'threshold', requestId });
        emit(S, { type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false, requestId });
      }
      // Fire-and-forget; abort sets `aborted`.
      S.aborted = false;
      streamTurn(S, cmd.message || '');
      return;
    }
    case 'steer':
      emit(S, { type: 'response', command: 'steer', success: true, id: cmd.id });
      return;
    case 'follow_up':
      emit(S, { type: 'response', command: 'follow_up', success: true, id: cmd.id });
      return;
    case 'abort':
      S.aborted = true;
      unblockChunk(S);
      if (HOLD_PROMPT) {
        const message = { role: 'assistant', content: [{ type: 'text', text: '[aborted]' }], provider: 'mock', model: 'mock-model', usage: USAGE, stopReason: 'aborted' };
        S.contractHistory = [...S.contractHistory, message];
        S.holdActive = false;
        S.holdGeneration++;
        emit(S, { type: 'message_end', message });
        emit(S, { type: 'turn_end', message, toolResults: [] });
        emit(S, { type: 'agent_end', messages: [message], willRetry: false });
        emit(S, { type: 'agent_settled' });
      }
      emit(S, { type: 'response', command: 'abort', success: true, id: cmd.id });
      return;
    case 'mock_wake_turn':
      if (DO_WAKE_TURN) wakeTurn(S);
      return;
    case 'mock_chunk_next':
      unblockChunk(S);
      return;
    case 'mock_complete':
      if (HOLD_PROMPT && S.holdActive) {
        const message = { role: 'assistant', content: [{ type: 'text', text: 'completed while detached' }], provider: 'mock', model: 'mock-model', usage: USAGE, stopReason: 'stop' };
        S.contractHistory = [...S.contractHistory, message];
        S.holdActive = false;
        S.holdGeneration++;
        emit(S, { type: 'message_end', message });
        emit(S, { type: 'turn_end', message, toolResults: [] });
        emit(S, { type: 'agent_end', messages: [message], willRetry: false });
        emit(S, { type: 'agent_settled' });
      }
      return;
    case 'get_state':
      emit(S, { type: 'response', command: 'get_state', success: true, id: cmd.id, data: rpcSessionState(S) });
      return;
    case 'get_available_models':
      emit(S, { type: 'response', command: 'get_available_models', success: true, id: cmd.id, data: { models: [{ id: 'mock-model', name: 'Mock', provider: 'mock', contextWindow: 200000, maxTokens: 4096 }] } });
      return;
    case 'set_model':
      emit(S, { type: 'response', command: 'set_model', success: true, id: cmd.id, data: { id: 'mock-model', name: 'Mock', provider: 'mock' } });
      return;
    case 'set_thinking_level':
      emit(S, { type: 'response', command: 'set_thinking_level', success: true, id: cmd.id });
      return;
    case 'get_commands':
      emit(S, { type: 'response', command: 'get_commands', success: true, id: cmd.id, data: { commands: omoCommands() } });
      return;
    case 'mock_commands_changed': {
      if (Array.isArray(cmd.commands)) commandInventory = cmd.commands;
      else if (cmd.count != null) commandInventory = Array.from({ length: Math.max(0, Number(cmd.count) || 0) }, (_, i) => command(`command-${String(i + 1).padStart(2, '0')}`, `Command ${i + 1}`));
      S.commandsGeneration++;
      for (const session of allSessions()) emit(session, { type: 'commands_changed', commands: omoCommands() });
      emit(S, { type: 'response', command: 'mock_commands_changed', success: true, id: cmd.id, data: { generation: S.commandsGeneration } });
      return;
    }
    case 'compact': {
      const sequence = ++S.compactSequence;
      const providerRequestId = `compact-provider-${++S.compactGeneration}`;
      const requestId = COMPACT_MISMATCH_REQUEST_ID ? `${providerRequestId}-mismatch` : providerRequestId;
      const error = MOCK_COMPACT_ERROR || 'Nothing to compact (mock session)';
      const response = { type: 'response', command: 'compact', success: !error, id: COMPACT_STALE_RESPONSE ? `stale-${cmd.id}` : cmd.id, ...(error ? { error } : {}) };
      const run = () => {
        emit(S, { type: 'compaction_start', reason: 'manual', requestId });
        if (COMPACT_STALE_A_SCENARIO && sequence === 2) {
          // Keep B active while publishing A's delayed RPC response and a
          // duplicate A end. This deterministic mode proves consumers
          // correlate both namespaces instead of completing the current B.
          emit(S, { type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, requestId: 'compact-provider-1' });
          if (S.delayedCompactResponse) emit(S, S.delayedCompactResponse);
          S.delayedCompactResponse = undefined;
          return;
        }
        emit(S, { type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, requestId, ...(error ? { errorMessage: error } : {}) });
        if (COMPACT_STALE_A_SCENARIO && sequence === 1) S.delayedCompactResponse = response;
        else emit(S, response);
        if (COMPACT_DUPLICATE_REQUEST_ID) emit(S, { type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, requestId });
      };
      setTimeout(run, COMPACT_DELAY_MS);
      return;
    }
    case 'get_session_stats':
      emit(S, { type: 'response', command: 'get_session_stats', success: true, id: cmd.id, data: { sessionFile: null, sessionId: 'mock-session', userMessages: 1, assistantMessages: 1, toolCalls: DO_TOOL ? 1 : 0, toolResults: DO_TOOL ? 1 : 0, totalMessages: 2, tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 }, cost: 0.001, contextUsage: { tokens: 150, contextWindow: 200000, percent: 0 } } });
      return;
    case 'get_entries': {
      const entries = S.contractHistory.map((message, index) => (
        message.type === 'custom_message'
          ? { id: `contract-${index + 1}`, ...message }
          : { id: `contract-${index + 1}`, type: 'message', message }
      ));
      emit(S, { type: 'response', command: 'get_entries', success: true, id: cmd.id, data: { entries, leafId: entries.at(-1)?.id || null } });
      return;
    }
    case 'new_session': {
      if (MULTI_SESSION) {
        // Fresh conversation under the same routing handle.
        S.durableSessionId = randomUUID();
        S.contractHistory = [];
        S.aborted = false;
        S.holdActive = false;
        S.holdGeneration++;
        S.activeResumeIdentity = RESUME_IDENTITY;
        emit(S, { type: 'response', command: 'new_session', success: true, id: cmd.id, data: { cancelled: false, sessionId: S.durableSessionId } });
        return;
      }
      const identity = { sessionId: 'mock-omo-new' };
      emit(S, { type: 'response', command: 'new_session', success: true, id: cmd.id, data: { cancelled: false, ...identity } });
      return;
    }
    case 'switch_session': {
      if (FAIL_SWITCH) {
        emit(S, { type: 'response', command: 'switch_session', success: false, id: cmd.id, error: 'persisted session not found' });
        return;
      }
      if (!cmd.sessionPath) {
        emit(S, { type: 'response', command: 'switch_session', success: false, id: cmd.id, error: 'sessionPath is required' });
        return;
      }
      if (RESUME_CONTRACT_FILE) {
        let saved;
        try { saved = JSON.parse(fs.readFileSync(RESUME_CONTRACT_FILE, 'utf8')); }
        catch (err) {
          emit(S, { type: 'response', command: 'switch_session', success: false, id: cmd.id, error: 'resume contract state unavailable: ' + err.message });
          return;
        }
        if (cmd.sessionPath !== saved.identity) {
          emit(S, { type: 'response', command: 'switch_session', success: false, id: cmd.id, error: `wrong session identity: ${cmd.sessionPath}` });
          return;
        }
        S.activeResumeIdentity = saved.identity;
        S.contractHistory = saved.history;
      }
      const identity = { sessionId: cmd.sessionPath };
      emit(S, { type: 'response', command: 'switch_session', success: true, id: cmd.id, data: { cancelled: false, ...identity } });
      return;
    }
    case 'extension_ui_response': {
      const p = S.pendingApprovals.get(cmd.id);
      if (p) { S.pendingApprovals.delete(cmd.id); p.resolve({ value: cmd.value, confirmed: cmd.confirmed, cancelled: cmd.cancelled }); }
      return;
    }
    default:
      // Unknown but non-fatal: acknowledge generically so a strict client doesn't hang.
      emit(S, { type: 'response', command: cmd.type || 'unknown', success: true, id: cmd.id });
  }
}

// Swallow EPIPE if the host closes stdin early.
process.stdout.on('error', () => { /* host gone */ });
