import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, rm, writeFile, stat, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const appURL = 'http://127.0.0.1:25261';
export const fixtureURL = 'http://127.0.0.1:25271';
const deadline = 15_000;

export async function driver() {
  const paths = [process.env.QA_PLAYWRIGHT, '/private/tmp/omo-asar/node_modules/playwright-core/index.mjs',
    '/private/tmp/zcode-asar/node_modules/playwright-core/index.mjs'].filter(Boolean);
  for (const path of paths) {
    try { await access(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    return (await import(pathToFileURL(resolve(path)).href)).chromium;
  }
  throw new Error('Set QA_PLAYWRIGHT to already-installed playwright-core/index.mjs');
}

export function isolatedEnvironment(root) {
  const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SystemRoot'].filter(key => process.env[key])
    .map(key => [key, process.env[key]]));
  const launcher = process.env.QA_OMO_JS ?? '/Users/mirage/.bun/install/global/node_modules/omo-ai/bin/omo.js';
  // The existing fixture socket is mandatory, so the app never needs to launch
  // an engine. If resolution occurs, use the installed package's own launcher.
  env.PATH = `${resolve(root, 'bin')}:${env.PATH}`;
  env.OMO_BIN = launcher;
  env.HOME = root;
  env.OMO_CODING_AGENT_DIR = resolve(root, 'agent');
  return env;
}

async function freePort(port) {
  await new Promise((yes, no) => {
    const probe = createServer(); probe.once('error', no);
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? no(error) : yes()));
  });
}

function tracked(command, args, options, resources, label) {
  const child = spawn(command, args, { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const argv = [command, ...args.map((arg, index) => args[index - 1] === '--password' ? '[REDACTED]' : arg)];
  const record = { label, argv, cwd: options.cwd, environmentKeys: Object.keys(options.env).sort(),
    pid: child.pid, output: '', exited: false };
  resources.push(record);
  child.stdout.on('data', data => { record.output += data; });
  child.stderr.on('data', data => { record.output += data; });
  record.exit = new Promise((yes, no) => {
    child.once('error', no);
    child.once('close', (code, signal) => { Object.assign(record, { exited: true, code, signal }); yes({ code, signal }); });
  });
  record.exit.catch(() => {});
  record.child = child;
  return record;
}

async function ready(record, marker) {
  if (record.output.includes(marker)) return;
  await new Promise((yes, no) => {
    const finish = error => {
      clearTimeout(timer); record.child.stdout.off('data', check); record.child.stderr.off('data', check);
      error ? no(error) : yes();
    };
    const check = () => { if (record.output.includes(marker)) finish(); };
    const timer = setTimeout(() => finish(new Error(`${record.label} readiness deadline: ${record.output}`)), deadline);
    record.child.stdout.on('data', check); record.child.stderr.on('data', check);
    record.exit.then(() => finish(new Error(`${record.label} exited before ready: ${record.output}`)), finish);
    check();
  });
}

async function terminate(record) {
  if (!record.exited) {
    process.kill(-record.pid, 'SIGTERM');
    let timer;
    try {
      await Promise.race([record.exit, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${record.label}: shutdown deadline`)), deadline);
      })]);
    } catch (error) {
      if (!record.exited) process.kill(-record.pid, 'SIGKILL');
      await record.exit;
      throw error;
    } finally { clearTimeout(timer); }
  }
  return { label: record.label, pid: record.pid, argv: record.argv, cwd: record.cwd, environmentKeys: record.environmentKeys,
    exited: record.exited, code: record.code, signal: record.signal };
}

/** Owns only this invocation's binaries, Go processes and isolated root. */
export async function startRuntime({ evidenceDir, fixtureOnly = false } = {}) {
  assert.ok(evidenceDir, 'evidenceDir required');
  await mkdir(evidenceDir, { recursive: true });
  const base = resolve(repoRoot, '.omo/rpc46-qa/r1');
  await mkdir(base, { recursive: true });
  // Darwin Unix sockets need a short pathname; /tmp is too shared to use a
  // fixed root. The allocated root remains in this worktree's allowed scope.
  const root = resolve(base, randomBytes(2).toString('hex'));
  assert.ok(Buffer.byteLength(resolve(root, 'agent/rpc/rpc.sock')) < 104, 'Darwin Unix socket path must fit');
  await mkdir(root, { mode: 0o700 });
  const resources = [], receipt = { root, processes: [], errors: [] };
  let closed = false;
  const close = async () => {
    if (closed) return receipt;
    closed = true;
    for (const resource of [...resources].reverse()) {
      try { receipt.processes.push(await terminate(resource)); }
      catch (error) { receipt.errors.push(String(error)); }
      await writeFile(resolve(evidenceDir, `${resource.label}.log`), resource.output);
    }
    if (resources.every(row => row.exited)) {
      await rm(root, { recursive: true, force: true }); receipt.rootRemoved = true;
    }
    await writeFile(resolve(evidenceDir, 'runtime-cleanup.json'), JSON.stringify(receipt, null, 2) + '\n');
    if (receipt.errors.length) throw new Error(receipt.errors.join('\n'));
    return receipt;
  };
  try {
    await Promise.all([freePort(25271), ...(fixtureOnly ? [] : [freePort(25261)])]);
    if (!fixtureOnly) await access(resolve(repoRoot, 'frontend/dist/index.html'));
    const fixtureBin = resolve(root, 'fixture');
    const fixtureBuild = tracked('go', ['build', '-o', fixtureBin, './test/qa/rpc46-overflow-fixture.go'],
      { cwd: repoRoot, env: process.env }, resources, 'fixture-build');
    assert.equal((await fixtureBuild.exit).code, 0, fixtureBuild.output);
    let appBin;
    if (!fixtureOnly) {
      appBin = process.env.QA_APP_BINARY ? resolve(process.env.QA_APP_BINARY) : resolve(root, 'app');
      if (!process.env.QA_APP_BINARY) {
        const build = tracked('go', ['build', '-o', appBin, './cmd/server'], { cwd: repoRoot, env: process.env }, resources, 'app-build');
        assert.equal((await build.exit).code, 0, build.output);
      } else await access(appBin);
    }
    const env = isolatedEnvironment(root);
    await access(env.OMO_BIN);
    await mkdir(resolve(root, 'bin'));
    await symlink(env.OMO_BIN, resolve(root, 'bin/omo'));
    const fixture = tracked(fixtureBin, ['--root', root, '--control', '127.0.0.1:25271'], { cwd: repoRoot, env }, resources, 'fixture');
    await ready(fixture, 'RPC46_FIXTURE_READY');
    assert.ok((await stat(resolve(root, 'agent/rpc/rpc.sock'))).isSocket(), 'socket exists before app starts');
    receipt.fixtureSocketReadyBeforeApp = true;
    if (!fixtureOnly) {
      const app = tracked(appBin, ['--host', '127.0.0.1', '--port', '25261', '--state-dir', resolve(root, 'state'),
        '--root', root, '--password', 'rpc46-qa-only', '--provider', 'omo'], { cwd: repoRoot, env }, resources, 'app');
      await ready(app, 'listening');
    }
    return { root, appURL, fixtureURL, close, resources };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'startup and cleanup failed'); }
    throw error;
  }
}
