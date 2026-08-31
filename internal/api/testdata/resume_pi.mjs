#!/usr/bin/env node
import fs from 'node:fs';

const identity = process.env.MOCK_PI_RESUME_IDENTITY;
const contractFile = process.env.MOCK_PI_RESUME_CONTRACT;
const logFile = process.env.MOCK_PI_LOG || '';
const jsonLogFile = process.env.MOCK_PI_LOG_JSON || '';
const sessions = new Map();
let nextHandle = 0;
let input = '';

function send(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}
function emit(session, value) {
  send({ ...value, sessionId: session.handle });
}
function log(command) {
  if (logFile) fs.appendFileSync(logFile, `${command.type}\n`);
  if (jsonLogFile) fs.appendFileSync(jsonLogFile, JSON.stringify(command) + '\n');
}
function state(session) {
  return { sessionFile: identity, isStreaming: false, isCompacting: false, messageCount: session.history.length };
}

function handle(command) {
  log(command);
  if (command.type === 'open_session') {
    const session = { handle: `rpc-${++nextHandle}`, history: [] };
    if (command.sessionPath) {
      const saved = JSON.parse(fs.readFileSync(contractFile, 'utf8'));
      if (command.sessionPath !== saved.identity) throw new Error(`wrong resume identity ${command.sessionPath}`);
      session.history = saved.history;
    }
    sessions.set(session.handle, session);
    send({ type: 'response', command: 'open_session', success: true, id: command.id, sessionId: session.handle, data: { sessionId: session.handle, state: state(session) } });
    return;
  }
  const session = sessions.get(command.sessionId);
  if (!session) {
    send({ type: 'response', command: command.type, success: false, id: command.id, error: 'unknown_session' });
    return;
  }
  switch (command.type) {
    case 'prompt': {
      const assistant = { role: 'assistant', content: [{ type: 'text', text: `reply to ${command.message}` }], stopReason: 'stop' };
      session.history = [{ role: 'user', content: [{ type: 'text', text: command.message }] }, assistant];
      fs.writeFileSync(contractFile, JSON.stringify({ identity, history: session.history }));
      emit(session, { type: 'response', command: 'prompt', success: true, id: command.id });
      emit(session, { type: 'agent_start' });
      emit(session, { type: 'message_end', message: assistant });
      emit(session, { type: 'agent_settled' });
      return;
    }
    case 'get_state':
      emit(session, { type: 'response', command: 'get_state', success: true, id: command.id, data: state(session) });
      return;
    case 'get_available_models':
      emit(session, { type: 'response', command: 'get_available_models', success: true, id: command.id, data: { models: [] } });
      return;
    case 'get_commands':
      emit(session, { type: 'response', command: 'get_commands', success: true, id: command.id, data: { commands: [] } });
      return;
    case 'get_session_stats':
      emit(session, { type: 'response', command: 'get_session_stats', success: true, id: command.id, data: {} });
      return;
    case 'get_entries': {
      const entries = session.history.map((message, index) => ({ id: `entry-${index}`, type: 'message', message }));
      emit(session, { type: 'response', command: 'get_entries', success: true, id: command.id, data: { entries, leafId: entries.at(-1)?.id || null } });
      return;
    }
    case 'close_session':
      sessions.delete(session.handle);
      send({ type: 'response', command: 'close_session', success: true, id: command.id, sessionId: session.handle });
      return;
    default:
      emit(session, { type: 'response', command: command.type, success: true, id: command.id });
  }
}

process.stdin.on('data', chunk => {
  input += chunk.toString('utf8');
  for (let newline = input.indexOf('\n'); newline >= 0; newline = input.indexOf('\n')) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (!line.trim()) continue;
    try { handle(JSON.parse(line)); }
    catch (error) { send({ type: 'response', command: 'error', success: false, error: String(error.message || error) }); }
  }
});
process.stdin.on('end', () => process.exit(0));
