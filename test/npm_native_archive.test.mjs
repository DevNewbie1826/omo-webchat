import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

// Observe the actual tar boundary without substituting archive bytes or its
// execution. An absolute drive-letter path is remote syntax to Windows GNU tar.
const calls = [];
const realExec = promisify(childProcess.execFile);
const originalExecFile = childProcess.execFile;
function observedExecFile(...args) { return originalExecFile(...args); }
observedExecFile[promisify.custom] = (file, args, options) => {
  if (file === 'tar') calls.push({ args, cwd: options.cwd });
  return realExec(file, args, options);
};
childProcess.execFile = observedExecFile;
syncBuiltinESMExports();
const { readArtifacts } = await import('./npm_native_smoke.mjs');
const { createRegistry } = await import('./npm_registry_fixture.mjs');

function localArchives() {
  assert.ok(calls.length > 0, 'must execute real tar');
  for (const { args, cwd } of calls) {
    assert.ok(cwd && path.isAbsolute(cwd) && cwd.includes(' '), 'explicit archive-directory cwd with spaces');
    assert.equal(args[0], '-xzOf');
    assert.equal(args[1], `./${path.basename(args[1])}`, 'unambiguous local archive name, never drive-letter remote syntax');
  }
}

test('native and registry readers stream real archives from directories with spaces', async (t) => {
  const input = path.resolve(process.env.NATIVE_SMOKE_MANIFEST);
  const manifest = JSON.parse(await readFile(input, 'utf8'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'native archive spaces '));
  const oldTmp = Object.fromEntries(['TMPDIR', 'TMP', 'TEMP'].map((key) => [key, process.env[key]]));
  try {
    const archives = path.join(root, 'archive directory');
    await mkdir(archives);
    await cp(input, path.join(archives, 'manifest.json'));
    const tarballs = [];
    for (const record of manifest.packages) {
      const file = path.join(archives, record.file);
      await cp(path.join(path.dirname(input), record.file), file);
      tarballs.push(file);
    }
    await t.test('member uses local filename and cwd for every manifest and executable', async () => {
      calls.length = 0;
      const actual = await readArtifacts(path.join(archives, 'manifest.json'));
      assert.deepEqual(actual.manifest, manifest);
      assert.equal(calls.length, 13);
      localArchives();
    });
    await t.test('manifestFrom uses local filename and cwd for seeded registry archives', async () => {
      for (const key of Object.keys(oldTmp)) process.env[key] = root;
      calls.length = 0;
      const registry = await createRegistry({ tarballs });
      try {
        assert.equal(registry.packages.size, 7);
        assert.equal(calls.length, 7);
        localArchives();
      } finally { await registry.close(); }
      for (const { cwd } of calls) await assert.rejects(access(cwd), { code: 'ENOENT' });
    });
  } finally {
    for (const [key, value] of Object.entries(oldTmp)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
    await assert.rejects(access(root), { code: 'ENOENT' });
    t.diagnostic(JSON.stringify({ root, rootRemoved: true, archiveReads: calls }));
  }
});
