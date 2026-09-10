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
  for (const p of ctx.m.packages) {
    const put = ctx.registry.requests.findIndex((r) => r.method === 'PUT' && r.path === `/${p.name}`);
    const read = ctx.registry.requests.findIndex((r) => r.method === 'GET' && r.path === `/${p.name}/-/${p.file}`);
    const nextPut = ctx.registry.requests.findIndex((r, i) => i > put && r.method === 'PUT');
    assert.ok(read > put && (nextPut === -1 || read < nextPut), 'confirm actual accepted bytes before continuing');
  }
  const count = ctx.events.length;
  const resumeStart = ctx.registry.requests.length;
  ok(await publish(ctx));
  assert.equal(ctx.events.length, count);
  assert.deepEqual(ctx.registry.requests.slice(resumeStart).filter((r) => r.path.includes('/-/')).map((r) => r.path),
    ctx.m.packages.map((p) => `/${p.name}/-/${p.file}`), 'resume must fetch every existing tarball');
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
      else payload.optionalDependencies['omo-webchat-windows-arm64'] = '9.9.9';
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
for (const advertisedIntegrityLies of [false, true]) {
  test(`different real remote tarball bytes for the last immutable version prevent every write; advertisedIntegrityLies=${advertisedIntegrityLies}`, options, async (t) => {
    const ctx = await setup(t);
    const { sync } = await helpers;
    const last = ctx.m.packages.at(-1);
    const dir = path.join(ctx.root, 'remote-mutation'); fs.mkdirSync(dir);
    sync('tar', ['-xf', path.join(ctx.out, last.file), '-C', dir]);
    fs.appendFileSync(path.join(dir, 'package/cli.js'), '\n// different real package bytes\n');
    const npmCli = ctx.env.RELEASE_NPM_CLI || path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
    const [packed] = JSON.parse(sync(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', dir], { cwd: path.join(dir, 'package'), env: ctx.env }));
    const registry = await (await registryModule).createRegistry({ tarballs: [path.join(dir, packed.filename)] });
    t.after(async () => {
      await registry.close();
      await listenerRefused(registry.url);
      t.diagnostic(JSON.stringify({ requests: registry.requests, cleanup: 'mutated registry joined; listener refused connection' }));
    });
    const doc = registry.packages.get(last.name);
    doc['dist-tags'] = { next: last.version };
    const stored = doc.versions[last.version];
    const response = await fetch(stored.dist.tarball, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actualSHA256 = createHash('sha256').update(bytes).digest('hex');
    const actualIntegrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    assert.notEqual(actualSHA256, last.sha256);
    assert.notEqual(actualIntegrity, last.integrity);
    if (advertisedIntegrityLies) stored.dist.integrity = last.integrity;
    registry.requests.length = 0; // Exclude the independent control read.
    fs.writeFileSync(ctx.env.npm_config_userconfig, `//${new URL(registry.url).host}/:_authToken=fixture-local-only\n`);
    const result = await publish(ctx, 'next', registry.url);
    t.diagnostic(JSON.stringify({ advertisedIntegrityLies, expectedSHA256: last.sha256, actualSHA256,
      expectedIntegrity: last.integrity, actualIntegrity, advertisedIntegrity: stored.dist.integrity, result,
      publisherTarballReads: registry.requests.filter((r) => r.path.includes('/-/')).length,
      writes: registry.requests.filter((r) => r.method === 'PUT').length }));
    failed(t, result, advertisedIntegrityLies ? /Remote tarball integrity mismatch/ : /Remote immutable integrity/);
    assert.equal(registry.requests.filter((r) => r.method === 'PUT').length, 0);
    if (advertisedIntegrityLies) assert.equal(registry.requests.filter((r) => r.path.includes('/-/')).length, 1);
  });
}
async function listenerRefused(url) {
  const socket = new net.Socket();
  const refused = once(socket, 'error', { signal: AbortSignal.timeout(5000) });
  socket.connect(new URL(url).port, '127.0.0.1');
  try { assert.equal((await refused)[0].code, 'ECONNREFUSED'); } finally { socket.destroy(); }
}
async function tarballServer(t, handler) {
  const requests = [];
  const server = http.createServer({ requestTimeout: 10_000, headersTimeout: 5000 }, (req, res) => {
    requests.push({ method: req.method, path: req.url, credentials: Boolean(req.headers.authorization || req.headers.cookie) });
    handler(req, res);
  });
  server.setTimeout(10_000, (socket) => socket.destroy());
  const listening = once(server, 'listening'); server.listen(0, '127.0.0.1'); await listening;
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    server.closeAllConnections(); await closed;
    await listenerRefused(url);
    t.diagnostic(JSON.stringify({ tarballRequests: requests, cleanup: 'tarball server joined; listener refused connection' }));
  });
  return { url, requests };
}
for (const phase of ['existing wrapper', 'newly stored platform']) {
  for (const issue of ['missing URL', 'non-string URL', 'malformed URL', 'relative URL', 'non-HTTP URL', 'URL credentials', 'HTTP 404', 'HTTP 500', 'disconnect', 'truncated body', 'redirect', 'wrong bytes']) {
    test(`remote tarball ${phase}: ${issue} stops publication`, options, async (t) => {
      const existing = phase === 'existing wrapper';
      const m = (await helpers).manifest(base);
      const entry = existing ? m.packages.at(-1) : m.packages[0];
      const ctx = await setup(t, existing ? { tarballs: [path.join(base.out, entry.file)] } : {});
      const bytes = fs.readFileSync(path.join(ctx.out, entry.file));
      const tarballs = await tarballServer(t, (req, res) => {
        if (issue === 'disconnect') { req.socket.destroy(); return; }
        if (issue === 'truncated body') {
          res.writeHead(200, { 'content-length': bytes.length + 1, connection: 'close' }); res.end(bytes); return;
        }
        if (issue === 'redirect') { res.writeHead(302, { location: `${tarballs.url}/destination` }); res.end(); return; }
        res.writeHead(issue === 'HTTP 404' ? 404 : issue === 'HTTP 500' ? 500 : 200);
        res.end(issue === 'wrong bytes' ? Buffer.concat([bytes, Buffer.from('different')]) : bytes);
      });
      function corrupt() {
        const doc = ctx.registry.packages.get(entry.name);
        doc['dist-tags'] = { next: entry.version };
        const dist = doc.versions[entry.version].dist;
        dist.tarball = `${tarballs.url}/package.tgz`;
        if (issue === 'missing URL') delete dist.tarball;
        if (issue === 'non-string URL') dist.tarball = [dist.tarball];
        if (issue === 'malformed URL') dist.tarball = 'http://[';
        if (issue === 'relative URL') dist.tarball = '/package.tgz';
        if (issue === 'non-HTTP URL') dist.tarball = `file://${path.join(ctx.out, entry.file)}`;
        if (issue === 'URL credentials') dist.tarball = `${tarballs.url.replace('://', '://fixture:secret@')}/package.tgz`;
      }
      if (existing) corrupt();
      else ctx.registry.events.once('publish', corrupt); // Storage precedes this exact event and confirmation follows it.
      const result = await publish(ctx);
      failed(t, result, issue.includes('URL') ? /Invalid remote tarball URL/ : issue.startsWith('HTTP') ? /Remote tarball HTTP/ : issue === 'wrong bytes' ? /Remote tarball integrity mismatch/ : /fetch failed|terminated/);
      assert.equal(ctx.registry.requests.filter((r) => r.method === 'PUT').length, existing ? 0 : 1);
      assert.equal(ctx.registry.packages.has('omo-webchat'), existing);
      assert.equal(tarballs.requests.length, issue.includes('URL') ? 0 : 1);
      assert.ok(tarballs.requests.every((r) => !r.credentials));
    });
  }
}
test('matching cross-origin tarball reads carry no registry credentials and precede all writes', options, async (t) => {
  const m = (await helpers).manifest(base);
  const last = m.packages.at(-1);
  const ctx = await setup(t, { tarballs: [path.join(base.out, last.file)] });
  const bytes = fs.readFileSync(path.join(ctx.out, last.file));
  const tarballs = await tarballServer(t, (req, res) => {
    assert.equal(ctx.events.length, 0, 'existing wrapper bytes must be read before any platform write');
    res.end(bytes);
  });
  const doc = ctx.registry.packages.get(last.name);
  doc['dist-tags'] = { next: last.version };
  doc.versions[last.version].dist.tarball = `${tarballs.url}/package.tgz?download=fixture`;
  // Even configured credentials for the tarball host must not reach byte reads.
  fs.appendFileSync(ctx.env.npm_config_userconfig, `//${new URL(tarballs.url).host}/:_authToken=tarball-host-sentinel\n`);
  (await helpers).ok(await publish(ctx));
  assert.deepEqual(tarballs.requests, [{ method: 'GET', path: '/package.tgz?download=fixture', credentials: false }]);
  assert.deepEqual(ctx.events.map((e) => e.name), ctx.m.packages.slice(0, 6).map((p) => p.name));
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

test('publication confirmation polls through delayed registry visibility', options, async (t) => {
  const ctx = await setup(t, { hidePublishedGets: 2 });
  const { ok } = await helpers;
  ctx.env.NPM_CONFIRM_POLL_MS = '25';
  ok(await publish(ctx));
  assert.deepEqual(ctx.events.map((e) => e.name), ctx.m.packages.map((p) => p.name));
  const puts = ctx.registry.requests.flatMap((r, index) => (r.method === 'PUT' ? [{ ...r, index }] : []));
  assert.equal(puts.length, ctx.m.packages.length);
  for (let p = 0; p < puts.length; p++) {
    const from = puts[p].index;
    const to = p + 1 < puts.length ? puts[p + 1].index : ctx.registry.requests.length;
    // Two concealed confirmation reads plus the revealing read per package.
    const reads = ctx.registry.requests.slice(from + 1, to)
      .filter((r) => r.method === 'GET' && r.path === `/${ctx.m.packages[p].name}`).length;
    assert.equal(reads, 3, `confirmation reads for ${ctx.m.packages[p].name}`);
  }
  const archiveReads = ctx.registry.requests.filter((r) => r.method === 'GET' && r.path.includes('/-/')).length;
  assert.equal(archiveReads, ctx.m.packages.length, 'exactly one archive validation per package');
});
