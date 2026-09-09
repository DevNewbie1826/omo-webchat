import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { fixture, command, ok, manifest } from './npm_delivery_fixture.mjs';
import { publishGitHub } from '../npm/github-release.mjs';

async function setup(t) {
  const ctx = fixture(t);
  ok(await command(ctx.root, ['pack', '--out', ctx.out], ctx.env));
  const state = { release: undefined, bytes: new Map(), requests: [], failure: undefined, status: undefined };
  const server = http.createServer(async (req, res) => {
    const route = new URL(req.url, 'http://localhost');
    state.requests.push({ method: req.method, path: route.pathname });
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (state.status) return send(state.status, { error: 'injected' });
    // GitHub's tag endpoint looks up published releases, not pending drafts.
    if (req.method === 'GET' && route.pathname.includes('/tags/')) return state.release && !state.release.draft ? send(200, state.release) : send(404, {});
    if (req.method === 'GET' && route.pathname.endsWith('/releases')) return send(200, state.release ? [state.release] : []);
    if (req.method === 'GET' && route.pathname.includes('/assets/')) {
      const bytes = state.bytes.get(Number(route.pathname.split('/').at(-1)));
      res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(bytes);
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    if (req.method === 'POST' && route.pathname.endsWith('/releases')) {
      if (state.release) return send(422, { error: 'Release already exists' });
      const value = JSON.parse(bytes);
      assert.equal(value.draft, true);
      state.release = { ...value, id: 1, assets: [], upload_url: `${ctx.apiURL}/upload{?name,label}` };
      return send(201, state.release);
    }
    if (req.method === 'POST' && route.pathname === '/upload') {
      const id = state.bytes.size + 1;
      const name = route.searchParams.get('name');
      state.bytes.set(id, bytes);
      state.release.assets.push({ id, name, size: bytes.length, state: 'uploaded' });
      if (state.failure === id) { state.failure = undefined; req.socket.destroy(); return; }
      return send(201, state.release.assets.at(-1));
    }
    if (req.method === 'PATCH') { Object.assign(state.release, JSON.parse(bytes)); return send(200, state.release); }
    send(500, { error: 'unexpected route' });
  });
  const listening = once(server, 'listening'); server.listen(0, '127.0.0.1'); await listening;
  ctx.apiURL = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    server.closeAllConnections(); await closed;
    t.diagnostic(JSON.stringify({ requests: state.requests, cleanup: 'GitHub protocol listener and connections joined' }));
  });
  const m = manifest(ctx);
  const deliver = () => publishGitHub(path.join(ctx.out, 'manifest.json'), { apiURL: ctx.apiURL, repository: 'fixture/repo', tag: `v${m.version}`, token: 'localhost-fixture', verifier: path.join(ctx.root, 'npm/release.mjs'), env: ctx.env });
  return { ctx, state, m, deliver };
}
test('GitHub draft holds exact assets until complete; accepted disconnect resumes without replacing bytes', { timeout: 120_000 }, async (t) => {
  const { ctx, state, m, deliver } = await setup(t);
  state.failure = 3;
  await assert.rejects(deliver(), /fetch failed/);
  assert.equal(state.release.draft, true);
  assert.equal(state.release.assets.length, 3);
  await deliver();
  assert.equal(state.release.draft, false);
  assert.equal(state.release.prerelease, true);
  assert.equal(state.release.assets.length, 9);
  for (const asset of state.release.assets) {
    const record = m.archives.find((a) => path.basename(a.file) === asset.name);
    assert.deepEqual(state.bytes.get(asset.id), await fs.readFile(path.join(ctx.out, record.file)));
  }
  const writes = state.requests.filter((r) => r.method !== 'GET').length;
  await deliver();
  assert.equal(state.requests.filter((r) => r.method !== 'GET').length, writes);
});
test('GitHub last existing asset byte mismatch prevents all writes', { timeout: 120_000 }, async (t) => {
  const { state, deliver } = await setup(t);
  await deliver();
  state.bytes.set(9, Buffer.from('different immutable bytes'));
  state.requests.length = 0;
  await assert.rejects(deliver(), /asset integrity mismatch/);
  assert.equal(state.requests.some((r) => r.method !== 'GET'), false);
});
test('GitHub non404 error is not permission to create a release', { timeout: 120_000 }, async (t) => {
  const { state, deliver } = await setup(t);
  state.status = 403;
  await assert.rejects(deliver(), /HTTP 403/);
  assert.deepEqual(state.requests.map((r) => r.method), ['GET']);
});
