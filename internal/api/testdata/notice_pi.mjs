#!/usr/bin/env node
// notice-pi — minimal fake multi-session provider for the durable-notice
// persistence api tests. Speaks the omo multi-session RPC JSONL protocol
// (LF-only framing, never splits on U+2028/U+2029). Once the session is up
// (first post-open query) it emits one transient and one durable advisory so
// the write-through boundary can be observed in the state file: only the
// durable notice may be persisted.
import { randomUUID } from 'node:crypto';

const NOTICE_MARKER = process.env.NOTICE_PI_MARKER || 'default';

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function emit(S, obj) {
  if (S.closed) return;
  send({ ...obj, sessionId: S.handle });
}

function respond(S, cmd, extra = {}) {
  emit(S, { type: 'response', command: cmd.type || 'unknown', success: true, id: cmd.id, ...extra });
}

const sessions = new Map(); // routing handle -> session state
let nextSessionNumber = 0;

function openSession(cmd) {
  const handle = `rpc-${++nextSessionNumber}`;
  const session = { handle, durableSessionId: randomUUID(), closed: false };
  sessions.set(handle, session);
  send({
    type: 'response', command: 'open_session', success: true, sessionId: handle, id: cmd.id,
    data: {
      sessionId: handle,
      state: { sessionId: session.durableSessionId, model: { id: 'mock-model', name: 'Mock', provider: 'mock', contextWindow: 200000, maxTokens: 4096 }, thinkingLevel: 'medium', isStreaming: false, isCompacting: false, sessionName: 'mock', messageCount: 0 },
    },
  });
}

function onCommand(S, cmd) {
  switch (cmd.type) {
    case 'get_state':
      // Emitted on the first post-open query: the open window is closed and
      // the session route is live, so both advisories are guaranteed to be
      // dispatched. Transient first, durable second: by the time the durable
      // write-through lands, the transient broadcast has already happened, so
      // a state file that ever contains only the durable record proves
      // transient traffic is skipped.
      emit(S, { type: 'auto_retry_start', attempt: 1, marker: NOTICE_MARKER });
      emit(S, { type: 'high_reasoning_warning', modelId: 'gpt-5.6-sol', provider: 'openai-codex', thinkingLevel: 'xhigh', marker: NOTICE_MARKER });
      respond(S, cmd, { data: { model: { id: 'mock-model', name: 'Mock', provider: 'mock', contextWindow: 200000, maxTokens: 4096 }, thinkingLevel: 'medium', isStreaming: false, isCompacting: false, sessionId: S.durableSessionId, sessionName: 'mock', messageCount: 0 } });
      return;
    case 'get_available_models':
      respond(S, cmd, { data: { models: [{ id: 'mock-model', name: 'Mock', provider: 'mock', contextWindow: 200000, maxTokens: 4096 }] } });
      return;
    case 'get_commands':
      respond(S, cmd, { data: { commands: [] } });
      return;
    case 'get_session_stats':
      respond(S, cmd, { data: { tokens: { input: 1, output: 1, total: 2 }, cost: 0 } });
      return;
    case 'get_entries':
      respond(S, cmd, { data: { entries: [], leafId: null } });
      return;
    default:
      respond(S, cmd);
  }
}

function handleCommand(cmd) {
  switch (cmd.type) {
    case 'open_session':
      openSession(cmd);
      return;
    case 'close_session': {
      const session = typeof cmd.sessionId === 'string' ? sessions.get(cmd.sessionId) : undefined;
      if (!session) {
        send({ type: 'response', command: 'close_session', success: false, error: 'unknown_session', id: cmd.id });
        return;
      }
      session.closed = true;
      sessions.delete(cmd.sessionId);
      send({ type: 'response', command: 'close_session', success: true, sessionId: cmd.sessionId, id: cmd.id });
      return;
    }
    default: {
      const session = typeof cmd.sessionId === 'string' ? sessions.get(cmd.sessionId) : undefined;
      if (!session) {
        send({ type: 'response', command: cmd.type || 'parse', success: false, error: 'missing_session_id', id: cmd.id });
        return;
      }
      try { onCommand(session, cmd); }
      catch (err) { emit(session, { type: 'response', command: cmd.type || 'parse', success: false, error: String(err && err.message || err), id: cmd.id }); }
    }
  }
}

// LF-only stdin line reader (never splits on U+2028/U+2029).
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl = buf.indexOf('\n');
  while (nl !== -1) {
    let line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    nl = buf.indexOf('\n');
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length === 0) continue;
    try { handleCommand(JSON.parse(line)); }
    catch (err) { send({ type: 'response', command: 'parse', success: false, error: String(err) }); }
  }
});
