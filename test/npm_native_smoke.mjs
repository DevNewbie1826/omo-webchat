// Native, test-only release consumer. No publication and no user profile writes.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRegistry } from './npm_registry_fixture.mjs';

const exec = promisify(execFile);
const SELF = fileURLToPath(import.meta.url);
const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'];
const DEADLINE = 90_000;
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

export async function bounded(promise, label, timeout = DEADLINE) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: deadline exceeded`)), timeout); })]);
  } finally { clearTimeout(timer); }
}

async function command(argv, options = {}) {
  const { stdout } = await exec(argv[0], argv.slice(1), { timeout: 30_000, maxBuffer: 64 * 1024 * 1024, ...options });
  return stdout;
}

export function assertBinary(bytes, platform, arch) {
  const fail = () => { throw new Error(`executable architecture mismatch: expected ${platform}-${arch}`); };
  if (bytes.length < 128) fail();
  if (platform === 'darwin') {
    if (bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== (arch === 'x64' ? 0x01000007 : 0x0100000c) || bytes.readUInt32LE(12) !== 2) fail();
  } else if (platform === 'linux') {
    if (bytes.subarray(0, 4).toString() !== '\x7fELF' || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== (arch === 'x64' ? 62 : 183)) fail();
  } else {
    const offset = bytes.readUInt32LE(0x3c);
    if (bytes.subarray(0, 2).toString() !== 'MZ' || offset + 6 > bytes.length || bytes.subarray(offset, offset + 4).toString() !== 'PE\0\0' || bytes.readUInt16LE(offset + 4) !== (arch === 'x64' ? 0x8664 : 0xaa64)) fail();
  }
}

async function member(tarball, name) {
  return command(['tar', '-xzOf', `./${path.basename(tarball)}`, `package/${name}`], { cwd: path.dirname(tarball), encoding: 'buffer' });
}

export async function readArtifacts(file) {
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.match(manifest.sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(manifest.packages.length, 7, 'exactly seven package tarballs required');
  const expected = new Set(['omo-webchat', ...TARGETS.map((target) => `omo-webchat-${target}`)]);
  const artifacts = [];
  for (const record of manifest.packages) {
    assert.ok(expected.delete(record.name), `unexpected/duplicate package ${record.name}`);
    assert.equal(record.version, manifest.version);
    assert.equal(record.file, `${record.name}-${manifest.version}.tgz`, 'canonical relative tarball path');
    const tarball = path.resolve(path.dirname(file), record.file);
    const relative = path.relative(await realpath(path.dirname(file)), await realpath(tarball));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'tarball escapes manifest directory');
    const bytes = await readFile(tarball);
    assert.equal(digest(bytes), record.sha256, `${record.name} SHA-256`);
    assert.equal(`sha512-${digest(bytes, 'sha512', 'base64')}`, record.integrity, `${record.name} integrity`);
    const pkg = JSON.parse((await member(tarball, 'package.json')).toString());
    assert.equal(pkg.name, record.name);
    assert.equal(pkg.version, manifest.version);
    if (record.name === 'omo-webchat') {
      assert.deepEqual(pkg.optionalDependencies, Object.fromEntries(TARGETS.map((target) => [`omo-webchat-${target}`, manifest.version])));
      assert.equal(record.platform, undefined);
      assert.equal(pkg.bin['omo-webchat'], 'cli.js');
    } else {
      const [platform, arch] = record.name.slice('omo-webchat-'.length).split('-');
      assert.deepEqual(record.platform, { os: platform, cpu: arch }, 'manifest platform metadata');
      assert.deepEqual(pkg.os, [platform]);
      assert.deepEqual(pkg.cpu, [arch]);
      const binary = await member(tarball, `exe/omo-webchat-bin${platform === 'win32' ? '.exe' : ''}`);
      assertBinary(binary, platform, arch);
    }
    artifacts.push({ ...record, tarball, pkg });
  }
  return { manifest, artifacts };
}

function isolatedEnvironment(root, registry) {
  // A whitelist prevents npm config, runtime preload hooks, credentials, engine
  // overrides, proxies and profile paths leaking from the invoking account.
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'LANG']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const home = path.join(root, 'home');
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(root, 'cache'),
    TMPDIR: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'),
    OMO_CODING_AGENT_DIR: path.join(root, 'agent'), SENPI_CODING_AGENT_DIR: path.join(root, 'agent'),
    OMO_RPC_CLIENT_CAPABILITIES: 'extension_events', SENPI_RPC_CLIENT_CAPABILITIES: 'extension_events',
    npm_config_registry: registry, NPM_CONFIG_REGISTRY: registry,
    npm_config_cache: path.join(root, 'npm-cache'), npm_config_userconfig: path.join(root, 'user.npmrc'), npm_config_globalconfig: path.join(root, 'global.npmrc'),
    npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_ignore_scripts: 'true', npm_config_fetch_retries: '0',
    BUN_INSTALL: path.join(root, 'bun'), BUN_INSTALL_CACHE_DIR: path.join(root, 'bun-cache'),
    TH_PASSWORD: randomBytes(24).toString('hex'), NO_COLOR: '1', TERM: 'xterm-256color',
  });
  return env;
}

async function runtimes() {
  assert.equal(Bun.version, '1.4.2', 'native smoke requires Bun 1.4.2');
  const target = `${process.platform}-${process.arch}`;
  assert.ok(TARGETS.includes(target), `unsupported native target ${target}`);
  const node = Bun.which('node');
  assert.ok(node, 'Node must be on PATH');
  const info = JSON.parse(await command([node, '-e', 'console.log(JSON.stringify({platform:process.platform,arch:process.arch,version:process.version}))']));
  assert.deepEqual(info, { platform: process.platform, arch: process.arch, version: 'v24.15.0' }, 'actual Node and Bun target/version');
  const machine = os.machine().toLowerCase();
  assert.ok((process.arch === 'arm64' ? ['arm64', 'aarch64'] : ['x86_64', 'amd64', 'x64']).includes(machine), `native machine mismatch: ${machine} vs ${target}`);
  if (process.env.RUNNER_ARCH) assert.equal(process.env.RUNNER_ARCH.toLowerCase(), process.arch, 'runner must match native architecture');
  if (process.platform === 'darwin') {
    const translated = await command(['/usr/sbin/sysctl', '-in', 'sysctl.proc_translated']);
    assert.notEqual(translated.trim(), '1', 'Rosetta is not native validation');
  }
  if (process.platform === 'win32') assert.ok(!process.env.PROCESSOR_ARCHITEW6432, 'WOW emulation is not native validation');
  const npx = Bun.which('npx');
  assert.ok(npx, 'npx must be on PATH');
  const candidates = [process.env.NATIVE_SMOKE_NPX_CLI, process.env.RELEASE_NPM_CLI && path.join(path.dirname(process.env.RELEASE_NPM_CLI), 'npx-cli.js'), await realpath(npx), path.join(path.dirname(npx), 'node_modules/npm/bin/npx-cli.js')].filter(Boolean);
  let npxCLI;
  for (const candidate of candidates) {
    if (!candidate.endsWith('npx-cli.js')) continue;
    try { await access(candidate); npxCLI = candidate; break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.ok(npxCLI, 'cannot locate actual npm npx-cli.js');
  const npmVersion = (await command([node, path.join(path.dirname(npxCLI), 'npm-cli.js'), '--version'])).trim();
  assert.equal(npmVersion, '11.12.1', 'native smoke requires lifecycle-compatible npm 11.12.1');
  return { node, npxCLI, nodeVersion: info.version, bunVersion: Bun.version, npmVersion, target, machine };
}

async function refused(address) {
  await bounded(new Promise((resolve, reject) => {
    const [host, port] = address.split(':');
    const socket = net.connect({ host, port: Number(port) });
    socket.once('connect', () => { socket.destroy(); reject(new Error(`listener still accepts: ${address}`)); });
    socket.once('error', (error) => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
  }), 'listener closed', 5_000);
}

async function httpBytes(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { response, bytes };
}

async function checkHTTP(address, assets, password) {
  const base = `http://${address}`;
  assert.ok(assets.some((asset) => asset.path === 'index.html'), 'fixture must embed index');
  assert.ok(assets.some((asset) => asset.path.endsWith('.js')), 'fixture must embed built JavaScript');
  assert.ok(assets.some((asset) => asset.path.endsWith('.css')), 'fixture must embed built CSS');
  const receipt = [];
  for (const asset of assets) {
    const route = asset.path === 'index.html' ? '/' : `/${asset.path.split('/').map(encodeURIComponent).join('/')}`;
    const { response, bytes } = await httpBytes(base + route);
    assert.equal(response.status, 200, `${route} status`);
    assert.equal(bytes.length, asset.size, `${route} byte length`);
    assert.equal(digest(bytes), asset.sha256, `${route} embedded byte identity`);
    receipt.push({ path: route, status: response.status, bytes: bytes.length, sha256: digest(bytes) });
  }
  let result = await httpBytes(base + '/api/auth/check');
  assert.equal(result.response.status, 401, 'unauthenticated auth check');
  result = await httpBytes(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(result.response.status, 200, 'login');
  const cookie = result.response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie?.startsWith('th_session='), 'login must issue session cookie');
  result = await httpBytes(base + '/api/auth/check', { headers: { cookie } });
  assert.equal(result.response.status, 200, 'authenticated auth check');
  assert.deepEqual(JSON.parse(result.bytes), { status: 'ok' });
  return { assets: receipt, auth: [401, 200, 200] };
}

// Worker is launched inside the fixture's tracked process domain. Windows uses
// a Job Object; the PTY's Unix process group is additionally checked here.
async function worker(file) {
  const config = JSON.parse(await readFile(file, 'utf8'));
  const ready = deferred();
  let tail = '', pending = '', address, child, completion, failure, http;
  let leaderJoined = false;
  // ConPTY requests win32-input-mode (DECSET 9001). In that mode a raw 0x03
  // byte is plain input, not Ctrl-C: the interrupt must be sent as structured
  // KEY_EVENT_RECORD sequences (Microsoft ConPTY keyboard spec).
  let win32InputMode = false;
  const win32CtrlC = [
    '\x1b[17;29;0;1;8;1_', // Ctrl down
    '\x1b[67;46;3;1;8;1_', // C down (char 0x03)
    '\x1b[67;46;3;0;0;1_', // C up
    '\x1b[17;29;0;0;0;1_', // Ctrl up
  ].join('');
  // Send both encodings: some ConPTY input paths only dispatch the console
  // CTRL_C_EVENT from the raw 0x03 byte, others from the structured records.
  const interrupt = () => child.terminal.write(win32InputMode ? win32CtrlC + '\x03' : '\x03');
  // Closing the terminal is the faithful owned interruption on ConPTY hosts
  // where input-encoded Ctrl-C never dispatches: the closed pseudoconsole
  // delivers the platform close event to the whole client chain.
  const closeTerminal = () => { if (child?.terminal) { try { child.terminal.close(); } catch { /* already closed */ } } };
  const channel = config.interrupt ?? (process.platform === 'win32' ? 'close' : 'input');
  const halt = () => { if (channel === 'close') closeTerminal(); else interrupt(); };
  const receipt = { event: 'consumer-result', variant: config.variant, command: config.command, cleanup: {} };
  const stopped = deferred();
  // Subscribe before spawning. Fixture EOF asks the worker to clean its PTY,
  // rather than killing a worker that still owns a separate Unix session.
  const stop = () => stopped.reject(new Error('fixture requested worker shutdown'));
  process.stdin.once('end', stop);
  process.stdin.resume();
  stopped.promise.catch(() => {});
  try {
    child = Bun.spawn(config.command, {
      cwd: config.root, env: process.env,
      terminal: { cols: 160, rows: 40, data(_terminal, bytes) {
        const text = Buffer.from(bytes).toString();
        tail = (tail + text).slice(-32_768);
        pending += text;
        if (text.includes('\x1b[?9001h')) win32InputMode = true;
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
          pending = pending.slice(newline + 1);
          const match = /\bmsg=listening\s+addr="?(127\.0\.0\.1:\d+)/.exec(line);
          if (match) { address = match[1]; ready.resolve(address); }
        }
        if (pending.length > 32_768) { ready.reject(new Error('readiness output exceeds limit')); pending = ''; }
      } },
    });
    receipt.pid = child.pid;
    // A signal exit resolves exited (e.g. 130) while Bun's exitCode stays null.
    completion = child.exited.then((code) => { leaderJoined = true; return code; });
    const exitedEarly = completion.then((code) => { throw new Error(`consumer exited before readiness (exit ${code})`); });
    // Attach before awaiting readiness, so early exits cannot pass or hang.
    await bounded(Promise.race([ready.promise, exitedEarly, stopped.promise]), 'packaged server readiness');
    receipt.address = address;
    http = await bounded(Promise.race([checkHTTP(address, config.assets, process.env.TH_PASSWORD), stopped.promise]), 'HTTP contract', 60_000);
    receipt.http = http;
    halt();
    receipt.interruption = channel === 'close' ? 'PTY terminal close' : (win32InputMode ? 'PTY win32-input Ctrl-C' : 'PTY Ctrl-C');
    const code = await bounded(completion, 'consumer Ctrl-C exit', 20_000);
    receipt.exitCode = code;
    // Input-channel Ctrl-C yields 0 or 130. Closing the pseudoconsole is the
    // faithful Windows channel; cmd.exe/npm report the console close as a
    // wrapper error exit (1) even though the server drained cleanly — that is
    // proven separately by leaderJoined/listenerClosed/no-forced cleanup.
    const accepted = channel === 'close' ? [0, 1, 130] : [0, 130];
    assert.ok(accepted.includes(code), `unexpected interruption exit ${code}`);
  } catch (error) { failure = error; }
  finally {
    if (child) {
      if (!leaderJoined) {
        halt();
        try { await bounded(completion, 'failure Ctrl-C cleanup', 15_000); }
        catch (error) {
          failure = new AggregateError([failure, error].filter(Boolean), 'consumer cleanup failed');
          if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill(); // fixture Job Object is the final Windows reaper
          await bounded(completion, 'forced consumer join', 10_000);
          receipt.cleanup.forced = true;
        }
      }
      child.terminal.close();
      receipt.cleanup.leaderJoined = leaderJoined;
      if (process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 0);
          process.kill(-child.pid, 'SIGKILL');
          throw new Error(`consumer process group remains: ${child.pid}`);
        } catch (error) {
          if (error.code !== 'ESRCH') failure = new AggregateError([failure, error].filter(Boolean), 'process group cleanup failed');
          else receipt.cleanup.processGroupGone = true;
        }
      }
    }
    if (address) {
      try { await refused(address); receipt.cleanup.listenerClosed = true; }
      catch (error) { failure = new AggregateError([failure, error].filter(Boolean), 'listener cleanup failed'); }
    }
    receipt.ok = !failure;
    if (failure) { receipt.error = failure.message; receipt.output = tail; }
    process.stdin.off('end', stop);
    process.stdin.pause();
    console.log(JSON.stringify(receipt));
  }
  if (failure) process.exitCode = 1;
}

async function consume({ variant, root, registry, fixture, version, runtime }) {
  const env = isolatedEnvironment(root, registry);
  env.CHAT_PI_BINARY = fixture; // existing fixture endpoint is reused, never a user engine
  for (const directory of [env.HOME, env.APPDATA, env.LOCALAPPDATA, env.TMPDIR]) await mkdir(directory, { recursive: true });
  for (const file of [env.npm_config_userconfig, env.npm_config_globalconfig]) await writeFile(file, '');
  await writeFile(path.join(root, 'bunfig.toml'), `[install]\nregistry = ${JSON.stringify(registry)}\n`);
  const args = [`omo-webchat@${version}`, '--host', '127.0.0.1', '--port', '0', '--root', env.HOME, '--state-dir', path.join(root, 'state')];
  const argv = variant === 'npx' ? [runtime.node, runtime.npxCLI, '--yes', ...args]
    : [process.execPath, 'x', ...(variant === 'bunx --bun' ? ['--bun'] : []), ...args];
  const events = [], ready = deferred();
  let pending = '', stderr = '';
  const child = Bun.spawn([fixture, '--root', root], { cwd: root, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const stdoutDone = (async () => {
    for await (const bytes of child.stdout) {
      pending += Buffer.from(bytes).toString();
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const record = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
        events.push(record);
        if (record.event === 'fixture-ready') ready.resolve(record);
      }
    }
  })();
  const stderrDone = (async () => { for await (const bytes of child.stderr) stderr = (stderr + Buffer.from(bytes).toString()).slice(-16_384); })();
  let failure;
  try {
    const info = await bounded(Promise.race([ready.promise, child.exited.then((code) => { throw new Error(`fixture exited before ready (${code}): ${stderr}`); }), stdoutDone.then(() => { throw new Error('fixture output ended before ready'); })]), 'fixture ready');
    assert.equal(info.platform, process.platform === 'win32' ? 'windows' : process.platform, 'actual Go fixture platform');
    assert.equal(info.arch, process.arch === 'x64' ? 'amd64' : 'arm64', 'actual Go fixture architecture');
    const config = path.join(root, 'worker.json');
    await writeFile(config, JSON.stringify({ variant, root, command: argv, assets: info.assets }));
    child.stdin.write(JSON.stringify({ command: [process.execPath, SELF, '--worker', config] }) + '\n');
    await child.stdin.flush();
    const code = await bounded(child.exited, 'native fixture and consumer completion', 180_000);
    await Promise.all([stdoutDone, stderrDone]);
    const consumer = events.find((event) => event.event === 'consumer-result');
    const stopped = events.find((event) => event.event === 'fixture-stopped');
    assert.ok(consumer, `missing consumer receipt: ${stderr}`);
    assert.equal(code, 0, consumer.error ?? stderr);
    assert.equal(consumer.ok, true, consumer.error);
    assert.equal(consumer.cleanup.leaderJoined, true, 'consumer completion must be joined');
    assert.equal(consumer.cleanup.listenerClosed, true, 'consumer listener must be closed');
    assert.notEqual(consumer.cleanup.forced, true, 'consumer must drain without force');
    if (process.platform !== 'win32') assert.equal(consumer.cleanup.processGroupGone, true, 'consumer process group must be gone');
    assert.equal(stopped?.treeGone, true, 'fixture process domain must be empty');
    assert.equal(stopped.forced, false, 'fixture must drain without force');
    assert.equal(stopped.workerExit, 0, 'worker must complete successfully');
    assert.ok(stopped.handshakes > 0, 'packaged server must negotiate with native RPC fixture');
  } catch (error) { failure = error; }
  finally {
    child.stdin.end(); // private portable stop channel, including pre-readiness failures
    try { await bounded(child.exited, 'fixture EOF cleanup', 30_000); }
    catch (error) { child.kill(); failure = new AggregateError([failure, error].filter(Boolean), 'fixture EOF cleanup failed'); await bounded(child.exited, 'forced fixture join', 10_000); }
    await Promise.all([stdoutDone, stderrDone]);
  }
  const receipt = { variant, command: argv, fixturePID: child.pid, fixtureExit: child.exitCode, events, stderr };
  if (failure) throw Object.assign(new Error(failure.message), { receipt });
  return receipt;
}

export async function runSmoke({ manifest: file, fixture, registry: publicRegistry, variants = ['npx', 'bunx', 'bunx --bun'] }) {
  const receipt = { event: 'native-smoke', mode: publicRegistry ? 'public-read-only' : 'prepublication', manifest: path.resolve(file), consumers: [], cleanup: {} };
  let registry, root, failure;
  try {
    const runtime = await runtimes();
    receipt.runtime = runtime;
    fixture = await realpath(fixture);
    assertBinary(await readFile(fixture), process.platform, process.arch);
    const { manifest, artifacts } = await readArtifacts(path.resolve(file));
    receipt.version = manifest.version; receipt.sourceCommit = manifest.sourceCommit;
    receipt.artifacts = artifacts.map(({ name, sha256, integrity }) => ({ name, sha256, integrity }));
    if (publicRegistry) {
      const url = new URL(publicRegistry);
      assert.ok(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'registry must be an uncredentialed HTTP(S) URL');
      // Read the supplied registry, verify its exact immutable bytes before use.
      for (const artifact of artifacts) {
        const metadata = await httpBytes(`${publicRegistry.replace(/\/$/, '')}/${artifact.name}/${manifest.version}`);
        assert.equal(metadata.response.status, 200, 'public version metadata');
        const pkg = JSON.parse(metadata.bytes);
        assert.equal(pkg.dist.integrity, artifact.integrity, 'public immutable integrity');
        const tarball = await httpBytes(pkg.dist.tarball);
        assert.equal(tarball.response.status, 200);
        assert.equal(digest(tarball.bytes), artifact.sha256, 'public immutable tarball');
      }
    } else registry = await createRegistry({ tarballs: artifacts.map((artifact) => artifact.tarball) });
    root = await mkdtemp(path.join(os.tmpdir(), 'omo-native-'));
    receipt.root = root;
    for (const variant of variants) {
      assert.ok(['npx', 'bunx', 'bunx --bun'].includes(variant));
      const directory = path.join(root, variant.replaceAll(' ', '-'));
      await mkdir(directory);
      try { receipt.consumers.push(await consume({ variant, root: directory, registry: publicRegistry ?? registry.url, fixture, version: manifest.version, runtime })); }
      catch (error) { if (error.receipt) receipt.consumers.push(error.receipt); throw error; }
    }
    if (registry) {
      assert.ok(registry.requests.every((request) => request.method === 'GET' || request.method === 'HEAD'), 'smoke must never publish');
      for (const name of ['omo-webchat', `omo-webchat-${process.platform}-${process.arch}`]) {
        assert.ok(registry.requests.some((request) => request.path.includes(`/${name}/-/`) && request.status === 200), `real client must fetch ${name} tarball`);
      }
    }
  } catch (error) { failure = error; }
  finally {
    if (registry) { await registry.close(); receipt.requests = registry.requests; receipt.cleanup.registryClosed = true; }
    if (root) { await rm(root, { recursive: true, force: true }); receipt.cleanup.rootRemoved = true; }
  }
  receipt.ok = !failure;
  if (failure) throw Object.assign(new Error(failure.message), { receipt });
  return receipt;
}

if (import.meta.main) {
  if (process.argv[2] === '--worker') await worker(process.argv[3]);
  else {
    try {
      const options = {};
      for (let index = 2; index < process.argv.length; index += 2) {
        const key = process.argv[index];
        assert.ok(['--manifest', '--fixture', '--registry'].includes(key) && process.argv[index + 1] && !options[key.slice(2)], `invalid CLI option ${key}`);
        options[key.slice(2)] = process.argv[index + 1];
      }
      assert.ok(options.manifest && options.fixture, 'usage: bun test/npm_native_smoke.mjs --manifest <file> --fixture <native-executable> [--registry <url>]');
      console.log(JSON.stringify(await runSmoke(options)));
    } catch (error) {
      console.error(JSON.stringify({ ...error.receipt, ok: false, error: error.message }));
      process.exitCode = 1;
    }
  }
}
