import { afterAll, beforeAll, test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRegistry } from './npm_registry_fixture.mjs';
import { bounded, readArtifacts, runSmoke } from './npm_native_smoke.mjs';

const exec = promisify(execFile);
const manifestFile = process.env.NATIVE_SMOKE_MANIFEST;
const fixture = process.env.NATIVE_SMOKE_FIXTURE;
const evidence = path.resolve('.omo/public-release/native-evidence/tests');
const hash = (bytes, algorithm, encoding) => createHash(algorithm).update(bytes).digest(encoding);
let base, original;

beforeAll(async () => {
  assert.ok(manifestFile && fixture, 'Set NATIVE_SMOKE_MANIFEST and NATIVE_SMOKE_FIXTURE to real packed release artifacts and the native Go fixture; these integration tests never skip.');
  original = await readArtifacts(path.resolve(manifestFile));
  base = await mkdtemp(path.join(os.tmpdir(), 'omo-native-negative-'));
  await mkdir(evidence, { recursive: true });
}, 60_000);
afterAll(async () => { if (base) await rm(base, { recursive: true, force: true }); });

function absent(pid) {
  assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH', `owned PID ${pid} remains`);
}

async function clean(receipt, runtime = true) {
  assert.equal(receipt.cleanup.rootRemoved, true);
  if (receipt.mode === 'prepublication') assert.equal(receipt.cleanup.registryClosed, true);
  await assert.rejects(access(receipt.root), { code: 'ENOENT' });
  for (const consumer of receipt.consumers) {
    absent(consumer.fixturePID);
    const stopped = consumer.events.find((event) => event.event === 'fixture-stopped');
    assert.equal(stopped?.treeGone, true, 'fixture-owned process domain must be empty');
    assert.equal(stopped.forced, false, 'negative artifact must not require harness teardown escalation');
    absent(stopped.workerPID);
    const result = consumer.events.find((event) => event.event === 'consumer-result');
    assert.equal(result?.cleanup.leaderJoined, true);
    absent(result.pid);
    if (process.platform !== 'win32') assert.equal(result.cleanup.processGroupGone, true);
    if (runtime) assert.equal(result.cleanup.listenerClosed, true);
  }
}

async function mutate(name, kind) {
  const root = path.join(base, name);
  await mkdir(root);
  const manifest = structuredClone(original.manifest);
  for (const record of manifest.packages) await cp(path.join(path.dirname(path.resolve(manifestFile)), record.file), path.join(root, record.file));
  const record = manifest.packages.find((pkg) => pkg.name === (kind === 'entrypoint' ? 'omo-webchat' : `omo-webchat-${process.platform}-${process.arch}`));
  const unpack = path.join(root, 'unpack');
  await mkdir(unpack);
  await exec('tar', ['-xzf', path.join(root, record.file), '-C', unpack], { timeout: 15_000 });
  const pkgDir = path.join(unpack, 'package');
  const exe = path.join(pkgDir, 'exe', `omo-webchat-bin${process.platform === 'win32' ? '.exe' : ''}`);
  if (kind === 'entrypoint') {
    await writeFile(path.join(pkgDir, 'cli.js'), '#!/usr/bin/env node\nconsole.log("native-negative-entrypoint");\nprocess.exit(0);\n', { mode: 0o755 });
  } else if (kind === 'executable') {
    // Valid native executable and fresh transport hashes, but not cmd/server.
    await cp(fixture, exe);
  } else if (kind === 'frontend') {
    // Rebuild the actual cmd/server with a deliberately different embedded
    // index. Transport, native execution, RPC and readiness all remain valid;
    // only HTTP byte identity is wrong. Never modify the checkout's frontend.
    const source = path.join(root, 'source');
    await mkdir(path.join(source, 'frontend'), { recursive: true });
    for (const name of ['go.mod', 'go.sum', 'cmd', 'internal']) await cp(path.resolve(name), path.join(source, name), { recursive: true });
    await cp(path.resolve('frontend/embed.go'), path.join(source, 'frontend/embed.go'));
    await cp(path.resolve('frontend/dist'), path.join(source, 'frontend/dist'), { recursive: true });
    const index = path.join(source, 'frontend/dist/index.html');
    const bytes = await readFile(index);
    bytes[0] = bytes[0] === 33 ? 63 : 33;
    await writeFile(index, bytes);
    await exec('go', ['build', '-trimpath', '-o', exe, './cmd/server'], { cwd: source, timeout: 180_000, env: { ...process.env, CGO_ENABLED: '0', GOOS: process.platform === 'win32' ? 'windows' : process.platform, GOARCH: process.arch === 'x64' ? 'amd64' : 'arm64' } });
  } else {
    const bytes = await readFile(exe);
    const other = process.arch === 'x64' ? 'arm64' : 'x64';
    if (process.platform === 'darwin') bytes.writeUInt32LE(other === 'x64' ? 0x01000007 : 0x0100000c, 4);
    else if (process.platform === 'linux') bytes.writeUInt16LE(other === 'x64' ? 62 : 183, 18);
    else bytes.writeUInt16LE(other === 'x64' ? 0x8664 : 0xaa64, bytes.readUInt32LE(0x3c) + 4);
    await writeFile(exe, bytes);
  }
  const npmCLI = process.env.RELEASE_NPM_CLI ?? (process.env.NATIVE_SMOKE_NPX_CLI && path.join(path.dirname(process.env.NATIVE_SMOKE_NPX_CLI), 'npm-cli.js'));
  assert.ok(npmCLI, 'Set RELEASE_NPM_CLI (or NATIVE_SMOKE_NPX_CLI) to the pinned npm installation for real mutation pack');
  const { stdout } = await exec(Bun.which('node'), [npmCLI, 'pack', '--json', '--ignore-scripts', '--pack-destination', root], {
    cwd: pkgDir, timeout: 30_000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root, npm_config_cache: path.join(root, 'cache'), npm_config_userconfig: path.join(root, 'user.npmrc'), npm_config_globalconfig: path.join(root, 'global.npmrc'), npm_config_update_notifier: 'false' },
  });
  const [packed] = JSON.parse(stdout);
  assert.equal(packed.filename, record.file);
  const bytes = await readFile(path.join(root, record.file));
  record.sha256 = hash(bytes, 'sha256', 'hex');
  record.integrity = `sha512-${hash(bytes, 'sha512', 'base64')}`;
  assert.equal(record.integrity, packed.integrity, 'mutation must have correct real npm transport integrity');
  const file = path.join(root, 'manifest.json');
  await writeFile(file, JSON.stringify(manifest));
  return file;
}

for (const kind of ['entrypoint', 'executable']) {
  for (const variant of ['npx', 'bunx', 'bunx --bun']) {
    test(`rejects wrong ${kind} with valid transport hashes via ${variant}, with cleanup`, async () => {
      const name = `${kind}-${variant.replaceAll(' ', '-')}`;
      const file = await mutate(name, kind);
      // This proves failure is the executable surface, not setup or hash validation.
      await readArtifacts(file);
      let failure;
      try { await runSmoke({ manifest: file, fixture, variants: [variant] }); }
      catch (error) { failure = error; }
      assert.ok(failure?.receipt, 'mutated executable was incorrectly accepted');
      await writeFile(path.join(evidence, `${name}-red.json`), JSON.stringify({ error: failure.message, ...failure.receipt }, null, 2));
      assert.equal(failure.receipt.ok, false);
      const consumer = failure.receipt.consumers[0];
      assert.ok(consumer, 'mutation must reach real package-manager execution');
      const result = consumer.events.find((event) => event.event === 'consumer-result');
      assert.match(result.error, /consumer exited before readiness/, 'expected executable rejection, not fixture/setup error');
      assert.equal(result.address, undefined);
      if (kind === 'entrypoint') assert.match(result.output, /native-negative-entrypoint/);
      else assert.match(result.output, /flag provided but not defined: -host/);
      assert.ok(failure.receipt.requests.some((request) => request.path.includes('/omo-webchat/-/') && request.status === 200));
      if (kind === 'executable') assert.ok(failure.receipt.requests.some((request) => request.path.includes(`/omo-webchat-${process.platform}-${process.arch}/-/`) && request.status === 200));
      await clean(failure.receipt, false);
    }, 240_000);
  }
}

test('rejects a wrong executable architecture even with recomputed npm integrity', async () => {
  const file = await mutate('architecture', 'architecture');
  await assert.rejects(readArtifacts(file), /executable architecture mismatch/);
  let failure;
  try { await runSmoke({ manifest: file, fixture }); } catch (error) { failure = error; }
  assert.match(failure?.message ?? '', /executable architecture mismatch/);
  assert.deepEqual(failure.receipt.consumers, []);
  assert.equal(failure.receipt.root, undefined, 'architecture preflight must not start a process or registry');
  await writeFile(path.join(evidence, 'architecture-red.json'), JSON.stringify({ error: failure.message, ...failure.receipt }, null, 2));
}, 120_000);

test('rejects wrong embedded HTTP bytes after real readiness and closes the live listener', async () => {
  const file = await mutate('frontend', 'frontend');
  await readArtifacts(file);
  let failure;
  try { await runSmoke({ manifest: file, fixture, variants: ['npx'] }); } catch (error) { failure = error; }
  assert.ok(failure?.receipt);
  const result = failure.receipt.consumers[0]?.events.find((event) => event.event === 'consumer-result');
  assert.match(result?.address ?? '', /^127\.0\.0\.1:\d+$/);
  assert.match(result.error, /embedded byte identity/);
  await clean(failure.receipt);
  await writeFile(path.join(evidence, 'frontend-red.json'), JSON.stringify({ error: failure.message, ...failure.receipt }, null, 2));
}, 300_000);

test('restored immutable artifacts pass all three real native consumer surfaces', async () => {
  const receipt = await runSmoke({ manifest: manifestFile, fixture });
  await writeFile(path.join(evidence, 'restored-green.json'), JSON.stringify(receipt, null, 2));
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.consumers.map((consumer) => consumer.variant), ['npx', 'bunx', 'bunx --bun']);
  for (const consumer of receipt.consumers) {
    const result = consumer.events.find((event) => event.event === 'consumer-result');
    assert.deepEqual(result.http.auth, [401, 200, 200]);
    assert.ok(result.http.assets.some((asset) => asset.path === '/'));
    assert.ok(result.http.assets.some((asset) => asset.path.endsWith('.js')));
    assert.ok(result.http.assets.some((asset) => asset.path.endsWith('.css')));
    assert.equal(result.interruption, 'PTY Ctrl-C');
  }
  await clean(receipt);
  // No test mutates the actual manifest/tarballs; GREEN rereads those exact bytes.
  assert.deepEqual((await readArtifacts(path.resolve(manifestFile))).manifest, original.manifest);
}, 360_000);

test('public mode reads the supplied registry with real clients and makes no writes', async () => {
  const registry = await createRegistry({ tarballs: original.artifacts.map((artifact) => artifact.tarball) });
  try {
    const receipt = await runSmoke({ manifest: manifestFile, fixture, registry: registry.url });
    assert.equal(receipt.mode, 'public-read-only');
    assert.ok(registry.requests.length > 7);
    assert.ok(registry.requests.every((request) => ['GET', 'HEAD'].includes(request.method)));
    await clean(receipt);
    await writeFile(path.join(evidence, 'supplied-registry-green.json'), JSON.stringify({ ...receipt, requests: registry.requests }, null, 2));
  } finally { await bounded(registry.close(), 'test registry cleanup', 10_000); }
}, 360_000);
