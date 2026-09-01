'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resolveAgent, resolveBinaryPath, resolvePlatformPackage } = require('./cli.js');

test('resolveAgent honors override, PATH, bundled fallback, then error', (t) => {
  assert.deepEqual(resolveAgent({ CHAT_PI_BINARY: '/custom/omo', PATH: '' }), {
    ok: true,
    source: 'env:CHAT_PI_BINARY',
    path: '/custom/omo',
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-agent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binary = path.join(dir, 'omo');
  fs.writeFileSync(binary, '#!/bin/sh\n');
  fs.chmodSync(binary, 0o755);
  assert.deepEqual(resolveAgent({ PATH: dir }), {
    ok: true,
    source: 'PATH',
    path: binary,
  });

  assert.deepEqual(resolveAgent({ PATH: '' }, { findBundledOmo: () => '/bundled/omo.js' }), {
    ok: true,
    source: 'omo-ai',
    path: '/bundled/omo.js',
  });

  const missing = resolveAgent({ PATH: '' }, { findBundledOmo: () => null });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /CHAT_PI_BINARY/);
});

test('resolveBinaryPath consumes platform package entrypoint', (t) => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-platform-package-'));
  t.after(() => fs.rmSync(packageRoot, { recursive: true, force: true }));
  const packageJson = path.join(packageRoot, 'package.json');
  const entrypoint = path.join(packageRoot, 'index.js');
  const expected = path.join(packageRoot, 'exe', 'omo-webchat-bin');
  fs.mkdirSync(path.dirname(expected));
  fs.writeFileSync(packageJson, JSON.stringify({ name: 'omo-webchat-darwin-arm64', main: 'index.js' }));
  fs.writeFileSync(entrypoint, `module.exports = ${JSON.stringify(expected)};\n`);
  fs.writeFileSync(expected, '#!/bin/sh\n');
  fs.chmodSync(expected, 0o755);

  const result = resolveBinaryPath('darwin', 'arm64', {
    resolvePackage: () => packageJson,
    loadPackage: () => {
      delete require.cache[entrypoint];
      return require(entrypoint);
    },
  });
  assert.deepEqual(result, {
    ok: true,
    path: expected,
    pkgName: 'omo-webchat-darwin-arm64',
  });
});

test('resolveBinaryPath distinguishes unsupported and missing packages', () => {
  assert.deepEqual(resolvePlatformPackage('freebsd', 'x64'), null);
  assert.match(resolveBinaryPath('freebsd', 'x64').reason, /unsupported platform/);
  assert.match(
    resolveBinaryPath('win32', 'x64', {
      resolvePackage: () => {
        throw new Error('missing');
      },
    }).reason,
    /not installed/,
  );
});
