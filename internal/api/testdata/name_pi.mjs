#!/usr/bin/env node
// name-pi — minimal fake multi-session provider for the chat auto-title/rename
// api tests. Speaks the omo multi-session RPC JSONL protocol (LF-only framing,
// never splits on U+2028/U+2029): untagged control commands (open_session,
// close_session), ephemeral "rpc-N" routing handles, a durable uuid surfaced in
// get_state payloads, and a top-level sessionId on every session frame.
// Configurable via env:
//   NAME_PI_LOG     file path; every stdin JSON line is appended verbatim
//   NAME_PI_TRIGGER file path; when it appears, emits session_info_changed
//                   carrying the JSON {"name"} it contains, then deletes it
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

const LOG = process.env.NAME_PI_LOG || '';
const TRIGGER = process.env.NAME_PI_TRIGGER || '';

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// Session frames are tagged with the routing handle and dropped once the
// session is closed, mirroring the real provider.
function emit(S, obj) {
  if (S.closed) return;
  send({ ...obj, sessionId: S.handle });
}

function respond(S, cmd, extra = {}) {
  emit(S, { type: 'response', command: cmd.type || 'unknown', success: true, id: cmd.id, ...extra });
}

function finishTurn(S) {
  emit(S, { type: 'agent_start' });
  emit(S, { type: 'turn_start' });
  const message = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], provider: 'mock', model: 'mock-model', stopReason: 'stop' };
  emit(S, { type: 'message_start', message: { role: 'assistant', content: [], provider: 'mock', model: 'mock-model' } });
  emit(S, { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'ok' } });
  emit(S, { type: 'message_end', message });
  emit(S, { type: 'turn_end', message, toolResults: [] });
  emit(S, { type: 'agent_end', messages: [message], willRetry: false });
  emit(S, { type: 'agent_settled' });
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
    case 'prompt':
      respond(S, cmd);
      finishTurn(S);
      return;
    case 'get_state':
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
  if (LOG) fs.appendFileSync(LOG, JSON.stringify(cmd) + '\n');
  // Control commands are untagged; every other command must carry the routing
  // handle and is answered only for a live session.
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
process.stdin.on('end', () => { process.exit(0); });

// On-demand session_info_changed: the test drops a trigger file, this loop
// consumes it. Polling lives in the fake (an out-of-band external process),
// so the event lands strictly after the test's trigger write. The event is
// broadcast to every live session, tagged with its routing handle.
if (TRIGGER) {
  setInterval(() => {
    let raw;
    try { raw = fs.readFileSync(TRIGGER, 'utf8'); } catch { return; }
    try { fs.unlinkSync(TRIGGER); } catch { /* already consumed */ }
    let name = '';
    try { name = JSON.parse(raw).name || ''; } catch { name = ''; }
    if (name) {
      for (const session of sessions.values()) emit(session, { type: 'session_info_changed', name });
    }
  }, 20);
}

// Swallow EPIPE if the host closes stdin early.
process.stdout.on('error', () => { /* host gone */ });
