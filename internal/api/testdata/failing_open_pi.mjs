#!/usr/bin/env node
// fail-open-pi — fake multi-session provider that refuses to resume: every
// open_session carrying a sessionPath answers with a failure (a stale or dead
// session file), while fresh cwd-backed opens succeed with a deterministic
// durable identity. It speaks the omo multi-session RPC JSONL protocol:
// untagged control commands, ephemeral "rpc-N" routing handles, and a
// top-level sessionId on every session frame.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

const FRESH_IDENTITY = 'fresh-identity-1';
const LOG = process.env.MOCK_PI_LOG || '';
const JSON_LOG = process.env.MOCK_PI_LOG_JSON || '';

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function logCommand(cmd) {
  if (LOG) fs.appendFileSync(LOG, (cmd.type || 'unknown') + '\n');
  if (JSON_LOG) fs.appendFileSync(JSON_LOG, JSON.stringify(cmd) + '\n');
}

function emit(S, obj) {
  if (S.closed) return;
  send({ ...obj, sessionId: S.handle });
}

function respond(S, cmd, extra = {}) {
  emit(S, { type: 'response', command: cmd.type || 'unknown', success: true, id: cmd.id, ...extra });
}

const sessions = new Map();
let nextSessionNumber = 0;

function openSession(cmd) {
  if (typeof cmd.sessionPath === 'string' && cmd.sessionPath !== '') {
    send({ type: 'response', command: 'open_session', success: false, id: cmd.id, error: 'persisted session not found: ' + cmd.sessionPath });
    return;
  }
  const handle = `rpc-${++nextSessionNumber}`;
  const session = { handle, durableSessionId: randomUUID(), closed: false };
  sessions.set(handle, session);
  send({
    type: 'response', command: 'open_session', success: true, sessionId: handle, id: cmd.id,
    data: {
      sessionId: handle,
      state: { sessionId: FRESH_IDENTITY, model: { id: 'mock-model', name: 'Mock', provider: 'mock', contextWindow: 200000, maxTokens: 4096 }, thinkingLevel: 'medium', isStreaming: false, isCompacting: false, sessionName: 'mock', messageCount: 0 },
    },
  });
}

function onCommand(S, cmd) {
  switch (cmd.type) {
    case 'get_state':
      respond(S, cmd, { data: { model: { id: 'mock-model', name: 'Mock', provider: 'mock', contextWindow: 200000, maxTokens: 4096 }, thinkingLevel: 'medium', isStreaming: false, isCompacting: false, sessionId: FRESH_IDENTITY, sessionName: 'mock', messageCount: 0 } });
      return;
    case 'get_available_models':
      respond(S, cmd, { data: { models: [{ id: 'mock-model', name: 'Mock', provider: 'mock', contextWindow: 200000, maxTokens: 4096 }] } });
      return;
    case 'get_commands':
      respond(S, cmd, { data: { commands: [] } });
      return;
    case 'get_entries':
      respond(S, cmd, { data: { entries: [], leafId: null } });
      return;
    default:
      respond(S, cmd);
  }
}

function handleCommand(cmd) {
  logCommand(cmd);
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

// Swallow EPIPE if the host closes stdin early.
process.stdout.on('error', () => { /* host gone */ });
