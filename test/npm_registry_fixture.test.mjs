import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRegistry } from './npm_registry_fixture.mjs';

const npmCLI = process.env.REGISTRY_TEST_NPM_CLI;
const deadline = 30_000;
const sha = (bytes, algorithm = 'sha512') => createHash(algorithm).update(bytes).digest(algorithm === 'sha1' ? 'hex' : 'base64');
const activeChildren = new Set();

// Allowlist, not a copy of the caller's environment: no auth, OIDC, NODE_OPTIONS,
// npm configuration, proxy settings or Bun configuration can leak into clients.
function isolatedEnv(root, url) {
  return {
    PATH: process.env.PATH,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC } : {}),
    HOME: root, USERPROFILE: root, TMPDIR: root, TEMP: root, TMP: root,
    XDG_CONFIG_HOME: root, XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
    BUN_INSTALL_CACHE_DIR: path.join(root, 'bun-cache'),
    npm_config_userconfig: path.join(root, 'user.npmrc'),
    npm_config_globalconfig: path.join(root, 'global.npmrc'),
    npm_config_cache: path.join(root, 'npm-cache'),
    npm_config_registry: url, npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false', npm_config_fund: 'false',
    npm_config_update_notifier: 'false', npm_config_fetch_retries: '0',
    npm_config_fetch_timeout: '10000',
  };
}

async function command(t, executable, args, cwd, env) {
  const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  activeChildren.add(child);
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), deadline);
  try {
    const [code, signal] = await once(child, 'close');
    t.diagnostic(JSON.stringify({ command: [path.basename(executable), ...args.map((arg) => arg === npmCLI ? '<npm-cli>' : arg.replaceAll(cwd, '<cwd>'))], code, signal }));
    if (code !== 0) t.diagnostic(JSON.stringify({ failureOutput: { stdout, stderr } }));
    assert.equal(signal, null, `command exceeded deadline: ${stdout}\n${stderr}`);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    activeChildren.delete(child);
  }
}

function ok(result) {
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function closeReceipt(t, registry) {
  await registry.close();
  await registry.close(); // Idempotent and joined, including idle keep-alive sockets.
  const socket = new net.Socket();
  const closed = once(socket, 'error', { signal: AbortSignal.timeout(5000) });
  socket.connect(new URL(registry.url).port, '127.0.0.1');
  try {
    const [error] = await closed;
    assert.equal(error.code, 'ECONNREFUSED');
  } finally { socket.destroy(); }
  t.diagnostic(JSON.stringify({ trace: registry.requests, teardown: 'listener refused connection after close' }));
}

async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'npm-registry-contract-'));
  let registry;
  const publications = [];
  t.after(async () => {
    try {
      if (registry) await closeReceipt(t, registry);
      t.diagnostic(JSON.stringify({ publications }));
    } finally { await rm(root, { recursive: true, force: true }); }
    await assert.rejects(access(root), { code: 'ENOENT' });
    assert.equal(activeChildren.size, 0);
    t.diagnostic('cleanup: temporary HOME/config/cache/packages removed; all client processes joined');
  });
  registry = await createRegistry(options);
  registry.events.on('publish', (event) => publications.push(event));
  const env = isolatedEnv(root, registry.url);
  await writeFile(env.npm_config_globalconfig, '');
  await writeFile(env.npm_config_userconfig, `registry=${registry.url}\n//${new URL(registry.url).host}/:_authToken=fixture-local-only\n`);
  await writeFile(path.join(root, 'bunfig.toml'), `[install]\nregistry = "${registry.url}"\n`);
  const npm = (args, cwd = root, overrides = {}) => command(t, npmCLI ? process.execPath : 'npm', npmCLI ? [npmCLI, ...args] : args, cwd, { ...env, ...overrides });
  return { root, registry, env, npm };
}

async function pack(ctx, manifest) {
  const dir = path.join(ctx.root, manifest.name.replaceAll('/', '-'), manifest.version);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ ...manifest, main: 'index.js', scripts: { prepack: 'exit 91', prepublishOnly: 'exit 92', install: 'exit 93' } }));
  await writeFile(path.join(dir, 'index.js'), `module.exports = ${JSON.stringify(manifest.name)};\n`);
  const [result] = JSON.parse(ok(await ctx.npm(['pack', '--json', '--ignore-scripts', '--pack-destination', ctx.root], dir)));
  return path.join(ctx.root, result.filename);
}

async function observed(registry, event, predicate, action) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(deadline)]);
  const received = new Promise((resolve, reject) => {
    function cleanup() { registry.events.off(event, listener); signal.removeEventListener('abort', aborted); }
    function listener(value) { if (predicate(value)) { cleanup(); resolve(value); } }
    function aborted() { cleanup(); reject(signal.reason); }
    registry.events.on(event, listener);
    signal.addEventListener('abort', aborted, { once: true });
  });
  try { return await Promise.all([action(), received]); }
  finally { controller.abort(); }
}

async function json(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  return { status: response.status, body: await response.json() };
}

function publishBody(name, version, bytes, extra = {}) {
  const filename = `${name}-${version}.tgz`;
  return {
    _id: name, name, 'dist-tags': { next: version },
    versions: { [version]: { name, version, dist: { integrity: `sha512-${sha(bytes)}`, shasum: sha(bytes, 'sha1') }, ...extra } },
    _attachments: { [filename]: { content_type: 'application/octet-stream', data: bytes.toString('base64'), length: bytes.length } },
  };
}

const options = { timeout: 120_000 };
test('real npm publish preserves bytes, scoped metadata, tags and immutable versions', options, async (t) => {
  const ctx = await setup(t);
  const { registry, npm } = ctx;
  const name = '@fixture/published';
  const tarball = await pack(ctx, { name, version: '1.0.0', os: [process.platform], cpu: [process.arch], optionalDependencies: { 'fixture-optional': '1.0.0' } });
  const bytes = await readFile(tarball);
  const [result, event] = await observed(registry, 'publish', (e) => e.name === name, () => npm(['publish', tarball, '--tag', 'next', '--ignore-scripts', '--provenance=false']));
  ok(result);
  assert.deepEqual(event, { number: 1, name, version: '1.0.0', outcome: 'stored' });
  const endpoint = `${registry.url}/${encodeURIComponent(name)}`;
  const metadata = await json(endpoint);
  assert.equal(metadata.status, 200);
  assert.deepEqual(metadata.body['dist-tags'], { next: '1.0.0' });
  const stored = metadata.body.versions['1.0.0'];
  assert.deepEqual(stored.os, [process.platform]);
  assert.deepEqual(stored.cpu, [process.arch]);
  assert.deepEqual(stored.optionalDependencies, { 'fixture-optional': '1.0.0' });
  assert.equal(stored.dist.integrity, `sha512-${sha(bytes)}`);
  assert.equal(stored.dist.shasum, sha(bytes, 'sha1'));
  assert.equal(new URL(stored.dist.tarball).origin, registry.url);
  assert.deepEqual(Buffer.from(await (await fetch(stored.dist.tarball, { signal: AbortSignal.timeout(10_000) })).arrayBuffer()), bytes);
  assert.deepEqual((await json(`${endpoint}/1.0.0`)).body, stored);
  assert.deepEqual((await json(`${endpoint}/next`)).body, stored);
  assert.deepEqual(registry.packages.get(name).versions['1.0.0'], stored);
  assert.equal((await json(`${endpoint}/latest`)).status, 404);
  const duplicate = await npm(['publish', tarball, '--tag', 'latest', '--ignore-scripts', '--provenance=false']);
  assert.notEqual(duplicate.code, 0);
  // npm 11 refuses this during its metadata preflight; send the same valid
  // publication over HTTP as well to prove the registry's own immutable check.
  const conflict = await json(endpoint, { method: 'PUT', body: JSON.stringify(publishBody(name, '1.0.0', bytes, stored)), headers: { 'content-type': 'application/json' } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'EPUBLISHCONFLICT');
  assert.deepEqual(registry.packages.get(name)['dist-tags'], { next: '1.0.0' });
  const stable = await pack(ctx, { name, version: '1.1.0' });
  ok(await npm(['publish', stable, '--tag', 'latest', '--ignore-scripts', '--provenance=false']));
  assert.deepEqual(registry.packages.get(name)['dist-tags'], { next: '1.0.0', latest: '1.1.0' });
  assert.equal((await json(`${registry.url}/not-present`)).status, 404);
  assert.equal((await json(endpoint, { method: 'DELETE' })).status, 405);
  assert.equal(JSON.stringify(registry.requests).includes('fixture-local-only'), false);
});

test('seeded real npm tarballs support npm and Bun installs with platform optional dependencies', options, async (t) => {
  const ctx = await setup(t);
  const host = 'fixture-native-host';
  const other = '@fixture/native-other';
  const wrapper = '@fixture/wrapper';
  const foreignOS = process.platform === 'win32' ? 'linux' : 'win32';
  const tarballs = [
    await pack(ctx, { name: host, version: '1.0.0', os: [process.platform], cpu: [process.arch] }),
    await pack(ctx, { name: other, version: '1.0.0', os: [foreignOS], cpu: ['x64'] }),
    await pack(ctx, { name: wrapper, version: '1.0.0', optionalDependencies: { [host]: '1.0.0', [other]: '1.0.0' } }),
  ];
  const seeded = await createRegistry({ tarballs });
  t.after(() => closeReceipt(t, seeded));
  for (const tarball of tarballs) {
    const bytes = await readFile(tarball);
    const version = [...seeded.packages.values()].flatMap((p) => Object.values(p.versions)).find((v) => v.dist.integrity === `sha512-${sha(bytes)}`);
    assert.ok(version, 'seed metadata must derive from exact archive bytes');
    assert.deepEqual(Buffer.from(await (await fetch(version.dist.tarball, { signal: AbortSignal.timeout(10_000) })).arrayBuffer()), bytes);
  }
  assert.deepEqual(seeded.packages.get(other).versions['1.0.0'].os, [foreignOS]);
  assert.deepEqual(seeded.packages.get(other).versions['1.0.0'].cpu, ['x64']);
  for (const client of ['npm', 'bun']) {
    const dir = path.join(ctx.root, client);
    await mkdir(dir);
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture-consumer', version: '1.0.0', dependencies: { [wrapper]: '1.0.0' } }));
    await writeFile(path.join(dir, 'bunfig.toml'), `[install]\nregistry = "${seeded.url}"\n`);
    const requestStart = seeded.requests.length;
    const action = () => client === 'npm'
      ? ctx.npm(['install', '--registry', seeded.url, '--ignore-scripts', '--no-audit', '--no-fund'], dir, { npm_config_cache: path.join(dir, 'cache') })
      : command(t, 'bun', ['install', '--ignore-scripts'], dir, { ...ctx.env, npm_config_registry: seeded.url });
    const [result] = await observed(seeded, 'request', (e) => e.method === 'GET' && decodeURIComponent(e.path).includes(wrapper), action);
    ok(result);
    const clientRequests = seeded.requests.slice(requestStart);
    assert.ok(clientRequests.some((r) => r.path.includes(`${host}/-/`)), `${client} must fetch native tarball from localhost, not pack cache`);
    assert.ok(clientRequests.some((r) => r.path.includes(`${wrapper}/-/`)), `${client} must fetch wrapper tarball from localhost, not pack cache`);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'node_modules', host, 'package.json'))).name, host);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'node_modules', wrapper, 'package.json'))).name, wrapper);
    await assert.rejects(access(path.join(dir, 'node_modules', other)), { code: 'ENOENT' });
  }
  assert.equal(seeded.requests.some((r) => r.method !== 'GET'), false);
  t.diagnostic(JSON.stringify({ seededTrace: seeded.requests }));
});

for (const mode of ['reject', 'disconnect-after-store']) {
  test(`real npm publish observes one-shot ${mode} on exactly the second publication`, options, async (t) => {
    const ctx = await setup(t, { failPublishAt: { number: 2, mode } });
    const name = 'fixture-failure';
    const files = [];
    for (const version of ['1.0.0', '1.0.1', '1.0.2']) files.push(await pack(ctx, { name, version }));
    ok(await ctx.npm(['publish', files[0], '--tag', 'next', '--ignore-scripts', '--provenance=false']));
    const [failed, event] = await observed(ctx.registry, 'publish', (e) => e.number === 2, () => ctx.npm(['publish', files[1], '--tag', 'next', '--ignore-scripts', '--provenance=false']));
    assert.notEqual(failed.code, 0);
    assert.equal(event.outcome, mode);
    assert.match(failed.stderr, mode === 'reject' ? /E503/ : /ECONNRESET|socket hang up/);
    assert.equal(Boolean(ctx.registry.packages.get(name).versions['1.0.1']), mode === 'disconnect-after-store');
    assert.equal(ctx.registry.packages.get(name)['dist-tags'].next, mode === 'reject' ? '1.0.0' : '1.0.1');
    ok(await ctx.npm(['publish', files[2], '--tag', 'next', '--ignore-scripts', '--provenance=false']));
    assert.equal(ctx.registry.packages.get(name)['dist-tags'].next, '1.0.2');
    assert.equal(ctx.registry.requests.filter((r) => r.method === 'PUT').length, 3);
  });
}

test('publication protocol rejects mutated integrity and metadata without storing anything', options, async (t) => {
  const ctx = await setup(t);
  const name = 'fixture-negative';
  const bytes = await readFile(await pack(ctx, { name, version: '1.0.0', os: [process.platform] }));
  for (const mutation of ['integrity', 'shasum', 'os', 'length', 'tag', 'invalid-json']) {
    const body = publishBody(name, '1.0.0', bytes, { os: [process.platform] });
    if (mutation === 'integrity') body.versions['1.0.0'].dist.integrity = `sha512-${sha(Buffer.from('wrong'))}`;
    if (mutation === 'shasum') body.versions['1.0.0'].dist.shasum = '0'.repeat(40);
    if (mutation === 'os') body.versions['1.0.0'].os = ['not-the-payload-os'];
    if (mutation === 'length') Object.values(body._attachments)[0].length++;
    if (mutation === 'tag') body['dist-tags'].next = '9.9.9';
    const response = await json(`${ctx.registry.url}/${name}`, { method: 'PUT', body: mutation === 'invalid-json' ? '{' : JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    assert.equal(response.status, 400, `${mutation} mutation must be rejected`);
    assert.equal(ctx.registry.packages.size, 0, `${mutation} mutation must leave no writes`);
    t.diagnostic(JSON.stringify({ mutation, status: response.status, packages: ctx.registry.packages.size }));
  }
});

test('real npm install rejects a deliberately corrupted integrity claim', options, async (t) => {
  const ctx = await setup(t);
  const name = 'fixture-corrupt-integrity';
  const tarball = await pack(ctx, { name, version: '1.0.0' });
  ok(await ctx.npm(['publish', tarball, '--ignore-scripts', '--provenance=false']));
  ctx.registry.packages.get(name).versions['1.0.0'].dist.integrity = `sha512-${sha(Buffer.from('not-the-tarball'))}`;
  const dir = path.join(ctx.root, 'negative-install');
  await mkdir(dir);
  await writeFile(path.join(dir, 'package.json'), '{"name":"negative-consumer","version":"1.0.0"}');
  const result = await ctx.npm(['install', `${name}@1.0.0`, '--ignore-scripts', '--no-audit', '--no-fund'], dir);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /EINTEGRITY/);
  t.diagnostic('negative client protocol: npm rejected corrupted integrity with EINTEGRITY');
});

test('close joins an in-flight incomplete publication and its connection', options, async (t) => {
  const { registry } = await setup(t);
  const socket = new net.Socket();
  t.after(() => socket.destroy());
  const connected = once(socket, 'connect', { signal: AbortSignal.timeout(5000) });
  socket.connect(new URL(registry.url).port, '127.0.0.1');
  await connected;
  const disconnected = once(socket, 'close', { signal: AbortSignal.timeout(5000) });
  await observed(registry, 'request', (event) => event.path === '/incomplete', async () => {
    socket.write('PUT /incomplete HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{');
  });
  await registry.close();
  await disconnected;
  assert.equal(registry.packages.size, 0);
  assert.equal(registry.requests[0].status, 'disconnected');
  assert.equal(registry.requests[0].error, 'ECONNRESET');
});

test('concealed publication becomes visible on the N+1st root read only', options, async (t) => {
  for (const hidden of [0, 1, 2]) {
    const ctx = await setup(t, { hidePublishedGets: hidden });
    const name = `fixture-conceal-${hidden}`;
    const bytes = await readFile(await pack(ctx, { name, version: '1.0.0' }));
    const put = await json(`${ctx.registry.url}/${name}`, { method: 'PUT', body: JSON.stringify(publishBody(name, '1.0.0', bytes)), headers: { 'content-type': 'application/json' } });
    assert.equal(put.status, 201);
    const visible = async () => {
      const read = await json(`${ctx.registry.url}/${name}`);
      return read.status === 200 && read.body.versions?.['1.0.0'] !== undefined;
    };
    for (let read = 0; read < hidden; read++) {
      assert.equal(await fetch(`${ctx.registry.url}/${name}`, { method: 'HEAD' }).then((r) => r.status), 200);
      assert.equal(await visible(), false, `hidden=${hidden} read=${read} must stay concealed`);
    }
    assert.equal(await visible(), true, `hidden=${hidden} must reveal after ${hidden} reads`);
  }
});

test('a concealed version stays immutable across duplicate publications', options, async (t) => {
  const ctx = await setup(t, { hidePublishedGets: 2 });
  const name = 'fixture-conceal-immutable';
  const bytes = await readFile(await pack(ctx, { name, version: '1.0.0' }));
  const publish = { method: 'PUT', headers: { 'content-type': 'application/json' } };
  const first = await json(`${ctx.registry.url}/${name}`, { ...publish, body: JSON.stringify(publishBody(name, '1.0.0', bytes)) });
  assert.equal(first.status, 201);
  await json(`${ctx.registry.url}/${name}`);
  const duplicate = await json(`${ctx.registry.url}/${name}`, { ...publish, body: JSON.stringify(publishBody(name, '1.0.0', await readFile(await pack(ctx, { name, version: '1.0.0' })))) });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error, 'EPUBLISHCONFLICT');
  assert.equal((await json(`${ctx.registry.url}/${name}`)).body.versions?.['1.0.0'], undefined, 'one budget read consumed, one remains');
  const revealed = await json(`${ctx.registry.url}/${name}`);
  assert.equal(revealed.body.versions['1.0.0'].dist.integrity, `sha512-${sha(bytes)}`);
});
