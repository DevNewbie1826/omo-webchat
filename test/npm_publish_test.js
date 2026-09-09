'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const test = require('node:test');
const helpers = import('./npm_delivery_fixture.mjs');
const registryModule = import('./npm_registry_fixture.mjs');
let base;
test.before(async () => {
  const { fixture, command, ok } = await helpers;
  const cleanup = [];
  base = fixture({ after: (fn) => cleanup.push(fn), diagnostic() {} });
  base.cleanup = () => cleanup.forEach((fn) => fn());
  ok(await command(base.root, ['pack', '--out', base.out], base.env));
});
test.after(() => base?.cleanup());
async function setup(t, options = {}) {
  const { fixture, manifest } = await helpers;
  const ctx = fixture(t);
  fs.cpSync(base.out, ctx.out, { recursive: true });
  const registry = await (await registryModule).createRegistry(options);
  const events = [];
  registry.events.on('publish', (event) => events.push(event));
  t.after(async () => {
    await registry.close();
    const socket = new net.Socket();
    const refused = once(socket, 'error', { signal: AbortSignal.timeout(5000) });
    socket.connect(new URL(registry.url).port, '127.0.0.1');
    try { assert.equal((await refused)[0].code, 'ECONNREFUSED'); } finally { socket.destroy(); }
    t.diagnostic(JSON.stringify({ requests: registry.requests, publications: events, cleanup: 'registry joined; listener refused connection' }));
  });
  fs.writeFileSync(ctx.env.npm_config_userconfig, `//${new URL(registry.url).host}/:_authToken=fixture-local-only\n`);
  return { ...ctx, registry, events, m: manifest(ctx) };
}
async function publish(ctx, tag = 'next', registry = ctx.registry.url) {
  const { command } = await helpers;
  return command(ctx.root, ['publish', '--manifest', path.join(ctx.out, 'manifest.json'), '--tag', tag, '--registry', registry], ctx.env);
}
function failed(t, result, pattern) {
  assert.notEqual(result.code, 0, result.stdout);
  if (pattern) assert.match(result.stderr, pattern);
  t.diagnostic(JSON.stringify({ expectedFailure: result }));
}
const options = { timeout: 180_000 };
test('real npm publishes all six platforms before wrapper with next; matching resume performs no writes', options, async (t) => {
  const ctx = await setup(t);
  const { ok } = await helpers;
  ok(await publish(ctx));
  assert.deepEqual(ctx.events.map((e) => e.name), ctx.m.packages.map((p) => p.name));
  assert.equal(ctx.events.at(-1).name, 'omo-webchat');
  for (const p of ctx.m.packages) {
    const stored = ctx.registry.packages.get(p.name);
    assert.deepEqual(stored['dist-tags'], { next: p.version });
    assert.equal(stored.versions[p.version].dist.integrity, p.integrity);
  }
  const firstPut = ctx.registry.requests.findIndex((r) => r.method === 'PUT');
  assert.equal(new Set(ctx.registry.requests.slice(0, firstPut).filter((r) => r.method === 'GET').map((r) => r.path.split('/')[1])).size, 7, 'all remote versions preflight before first write');
  const count = ctx.events.length;
  ok(await publish(ctx));
  assert.equal(ctx.events.length, count);
});
for (const mode of ['reject', 'disconnect-after-store']) {
  test(`real npm partial ${mode} preserves failure then resumes exact accepted versions`, options, async (t) => {
    const ctx = await setup(t, { failPublishAt: { number: 3, mode } });
    const observed = once(ctx.registry.events, 'publish', { signal: AbortSignal.timeout(120_000) });
    const [result] = await Promise.all([publish(ctx), observed]);
    failed(t, result, mode === 'reject' ? /E503/ : /ECONNRESET|socket hang up/);
    assert.equal(ctx.registry.packages.size, mode === 'reject' ? 2 : 3);
    assert.equal(ctx.registry.packages.has('omo-webchat'), false);
    assert.equal(ctx.events.length, 3);
    (await helpers).ok(await publish(ctx));
    assert.equal(ctx.registry.packages.size, 7);
    assert.equal(ctx.events.at(-1).name, 'omo-webchat');
    const stored = ctx.events.filter((e) => e.outcome !== 'reject');
    assert.equal(new Set(stored.map((e) => e.name)).size, stored.length, 'accepted immutable packages must never be republished');
  });
}
for (const issue of ['bad last hash', 'bad last bytes', 'bad integrity', 'traversal', 'duplicate', 'wrong name', 'wrong version', 'wrong platform', 'source mismatch', 'payload metadata', 'wrapper dependency', 'bad archive', 'tag mismatch', 'stable tag on RC']) {
  test(`ALL local validation before network/writes: ${issue}`, options, async (t) => {
    const ctx = await setup(t);
    const m = ctx.m;
    const last = m.packages.at(-1);
    if (issue === 'bad last hash') last.sha256 = '0'.repeat(64);
    if (issue === 'bad last bytes') fs.appendFileSync(path.join(ctx.out, last.file), 'mutated');
    if (issue === 'bad integrity') last.integrity = 'sha512-' + Buffer.alloc(64).toString('base64');
    if (issue === 'traversal') last.file = '../outside.tgz';
    if (issue === 'duplicate') m.packages[6] = m.packages[0];
    if (issue === 'wrong name') last.name = 'not-omo-webchat';
    if (issue === 'wrong version') last.version = '1.2.3-rc.2';
    if (issue === 'wrong platform') m.packages[0].platform.cpu = 'x64';
    if (issue === 'source mismatch') m.sourceCommit = '0'.repeat(40);
    if (issue === 'payload metadata' || issue === 'wrapper dependency') {
      const { sync } = await helpers;
      const dir = path.join(ctx.root, 'mutated'); fs.mkdirSync(dir);
      sync('tar', ['-xf', path.join(ctx.out, last.file), '-C', dir]);
      const file = path.join(dir, 'package/package.json');
      const payload = JSON.parse(fs.readFileSync(file));
      if (issue === 'payload metadata') payload.version = '9.9.9';
      else payload.optionalDependencies['omo-webchat-win32-arm64'] = '9.9.9';
      fs.writeFileSync(file, JSON.stringify(payload));
      const npmCli = ctx.env.RELEASE_NPM_CLI || path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
      const [packed] = JSON.parse(sync(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', ctx.out], { cwd: path.join(dir, 'package'), env: ctx.env }));
      if (packed.filename !== last.file) fs.renameSync(path.join(ctx.out, packed.filename), path.join(ctx.out, last.file));
      const bytes = fs.readFileSync(path.join(ctx.out, last.file));
      last.sha256 = createHash('sha256').update(bytes).digest('hex');
      last.integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    }
    if (issue === 'bad archive') fs.appendFileSync(path.join(ctx.out, m.archives[0].file), 'mutated');
    if (issue === 'tag mismatch') ctx.env.GITHUB_REF = 'refs/tags/v9.9.9';
    (await helpers).save(ctx, m);
    failed(t, await publish(ctx, issue === 'stable tag on RC' ? 'latest' : 'next'),
      issue === 'payload metadata' ? /payload identity mismatch/ : issue === 'wrapper dependency' ? /Wrapper dependency/ : undefined);
    assert.deepEqual(ctx.registry.requests, [], 'invalid local input must not access registry');
  });
}
for (const issue of ['integrity', 'identity', 'missing integrity', 'wrong dist-tag']) {
  test(`remote last-version ${issue} mismatch prevents all publication`, options, async (t) => {
    const m = (await helpers).manifest(base);
    const last = m.packages.at(-1);
    const ctx = await setup(t, { tarballs: [path.join(base.out, last.file)] });
    const doc = ctx.registry.packages.get(last.name);
    doc['dist-tags'] = { next: last.version };
    if (issue === 'integrity') doc.versions[last.version].dist.integrity = 'sha512-' + Buffer.alloc(64).toString('base64');
    if (issue === 'identity') doc.versions[last.version].name = 'other';
    if (issue === 'missing integrity') delete doc.versions[last.version].dist.integrity;
    if (issue === 'wrong dist-tag') doc['dist-tags'] = { latest: last.version };
    failed(t, await publish(ctx));
    assert.equal(ctx.registry.requests.filter((r) => r.method === 'PUT').length, 0);
  });
}
for (const status of [401, 403, 429, 500]) {
  test(`remote non-404 ${status} is not an absent package`, options, async (t) => {
    const ctx = await setup(t);
    const requests = [];
    const server = http.createServer((req, res) => { requests.push(req.method); res.writeHead(status, { 'content-type': 'application/json' }); res.end('{"error":"injected"}'); });
    const listening = once(server, 'listening'); server.listen(0, '127.0.0.1'); await listening;
    t.after(async () => { const closed = new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); server.closeAllConnections(); await closed; });
    failed(t, await publish(ctx, 'next', `http://127.0.0.1:${server.address().port}`), new RegExp(String(status)));
    assert.deepEqual(requests, ['GET']);
    assert.equal(ctx.events.length, 0);
  });
}
test('different real remote tarball bytes for the last immutable version prevent every write', options, async (t) => {
  const ctx = await setup(t);
  const { sync } = await helpers;
  const last = ctx.m.packages.at(-1);
  const dir = path.join(ctx.root, 'remote-mutation'); fs.mkdirSync(dir);
  sync('tar', ['-xf', path.join(ctx.out, last.file), '-C', dir]);
  fs.appendFileSync(path.join(dir, 'package/cli.js'), '\n// different real package bytes\n');
  const npmCli = ctx.env.RELEASE_NPM_CLI || path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  const [packed] = JSON.parse(sync(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', dir], { cwd: path.join(dir, 'package'), env: ctx.env }));
  const registry = await (await registryModule).createRegistry({ tarballs: [path.join(dir, packed.filename)] });
  t.after(() => registry.close());
  registry.packages.get(last.name)['dist-tags'] = { next: last.version };
  failed(t, await publish(ctx, 'next', registry.url), /Remote immutable integrity/);
  assert.equal(registry.requests.filter((r) => r.method === 'PUT').length, 0);
});
test('input changed during the final remote preflight is rejected before any npm write', options, async (t) => {
  const ctx = await setup(t);
  let changed = false;
  ctx.registry.events.on('request', (request) => {
    if (request.method === 'GET' && request.path === '/omo-webchat') {
      fs.appendFileSync(path.join(ctx.out, ctx.m.packages.at(-1).file), 'changed during remote preflight');
      changed = true;
    }
  });
  failed(t, await publish(ctx), /Artifact changed after preflight/);
  assert.equal(changed, true);
  assert.equal(ctx.registry.requests.some((r) => r.method === 'PUT'), false);
});
test('publisher derives platform-first order even if manifest lists wrapper first', options, async (t) => {
  const ctx = await setup(t);
  ctx.m.packages.reverse();
  (await helpers).save(ctx, ctx.m);
  (await helpers).ok(await publish(ctx));
  assert.equal(ctx.events.at(-1).name, 'omo-webchat');
  assert.equal(ctx.events.length, 7);
});
test('stable release uses actual npm publish --tag latest', options, async (t) => {
  const { fixture, command, ok } = await helpers;
  const ctx = fixture(t, '1.2.3');
  ok(await command(ctx.root, ['pack', '--out', ctx.out], ctx.env));
  const registry = await (await registryModule).createRegistry();
  t.after(() => registry.close());
  ctx.registry = registry;
  fs.writeFileSync(ctx.env.npm_config_userconfig, `//${new URL(registry.url).host}/:_authToken=fixture-local-only\n`);
  ok(await publish(ctx, 'latest'));
  for (const doc of registry.packages.values()) assert.deepEqual(doc['dist-tags'], { latest: '1.2.3' });
});
