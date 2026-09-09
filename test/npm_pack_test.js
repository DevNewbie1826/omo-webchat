'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const test = require('node:test');

const helpers = import('./npm_delivery_fixture.mjs');
test('pack runs strict generator and real npm pack for all seven exact packages without modifying source', { timeout: 120_000 }, async (t) => {
  const { fixture, command, ok, manifest, targets, version, sync } = await helpers;
  const ctx = fixture(t);
  const before = fs.readFileSync(path.join(ctx.root, 'npm/cli/package.json'));
  ok(await command(ctx.root, ['pack', '--out', ctx.out], ctx.env));
  const m = manifest(ctx);
  assert.equal(m.version, version);
  assert.equal(m.sourceCommit, ctx.sourceCommit);
  assert.deepEqual(m.packages.map((p) => p.name).sort(), ['omo-webchat', ...targets.map((p) => `omo-webchat-${p.replace(/^win32-/, 'windows-')}`)].sort());
  for (const p of m.packages) {
    assert.equal(p.version, version);
    assert.equal(path.basename(p.file), p.file);
    const bytes = fs.readFileSync(path.join(ctx.out, p.file));
    assert.equal(p.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(p.integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
    const payload = JSON.parse(sync('tar', ['-xOf', path.join(ctx.out, p.file), 'package/package.json']));
    assert.equal(payload.name, p.name);
    assert.equal(payload.version, version);
    if (p.platform) {
      assert.deepEqual(payload.os, [p.platform.os]); assert.deepEqual(payload.cpu, [p.platform.cpu]);
    } else assert.deepEqual(payload.optionalDependencies, Object.fromEntries(targets.map((p) => [`omo-webchat-${p.replace(/^win32-/, 'windows-')}`, version])));
  }
  assert.deepEqual(fs.readFileSync(path.join(ctx.root, 'npm/cli/package.json')), before);
  assert.equal(m.archives.length, 9); // Six archives, checksums and both notices.
  for (const a of m.archives) assert.equal(a.sha256, createHash('sha256').update(fs.readFileSync(path.join(ctx.out, a.file))).digest('hex'));
  ok(await command(ctx.root, ['verify', '--manifest', path.join(ctx.out, 'manifest.json')], ctx.env));
  const repeat = await command(ctx.root, ['pack', '--out', ctx.out], ctx.env);
  assert.notEqual(repeat.code, 0, 'successful immutable output must not be overwritten');
});
for (const issue of ['last archive missing', 'wrong executable', 'source mismatch', 'invalid version', 'tag mismatch']) {
  test(`pack rejects ${issue} without completed artifact output`, { timeout: 120_000 }, async (t) => {
    const { fixture, command } = await helpers;
    const ctx = fixture(t);
    const metadata = path.join(ctx.root, 'dist/metadata.json');
    if (issue === 'last archive missing') fs.rmSync(path.join(ctx.root, 'dist/omo-webchat_windows_arm64.zip'));
    if (issue === 'wrong executable') fs.copyFileSync(path.join(ctx.root, 'dist/omo-webchat_darwin_amd64.tar.gz'), path.join(ctx.root, 'dist/omo-webchat_linux_amd64.tar.gz'));
    if (issue === 'source mismatch') fs.writeFileSync(metadata, JSON.stringify({ version: '1.2.3-rc.1', commit: '0'.repeat(40) }));
    if (issue === 'invalid version') fs.writeFileSync(metadata, JSON.stringify({ version: '01.2.3', commit: ctx.sourceCommit }));
    if (issue === 'tag mismatch') ctx.env.GITHUB_REF = 'refs/tags/v1.2.4';
    const result = await command(ctx.root, ['pack', '--out', ctx.out], ctx.env);
    assert.notEqual(result.code, 0);
    assert.equal(fs.existsSync(path.join(ctx.out, 'manifest.json')), false);
    t.diagnostic(JSON.stringify({ issue, code: result.code, stderr: result.stderr }));
  });
}
