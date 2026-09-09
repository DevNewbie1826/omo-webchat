'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPO = path.resolve(__dirname, '..');
const VERSION = '1.2.3-rc.1';
const NOTICES = ['LICENSE', 'THIRD_PARTY_NOTICES.md'];
const TARGETS = [
  ['darwin', 'arm64', 'darwin', 'arm64'],
  ['darwin', 'x64', 'darwin', 'amd64'],
  ['linux', 'x64', 'linux', 'amd64'],
  ['linux', 'arm64', 'linux', 'arm64'],
  ['win32', 'x64', 'windows', 'amd64'],
  ['win32', 'arm64', 'windows', 'arm64'],
].map(([osNode, cpu, goos, goarch]) => ({ osNode, cpu, goos, goarch }));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, ...options });
  assert.ifError(result.error);
  return result;
}

function ok(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function binary(target) {
  // Format/architecture fixtures, not executable application builds.
  const bytes = Buffer.alloc(128);
  if (target.goos === 'windows') {
    bytes.write('MZ');
    bytes.writeUInt32LE(64, 0x3c);
    bytes.write('PE\0\0', 64);
    bytes.writeUInt16LE(target.cpu === 'x64' ? 0x8664 : 0xaa64, 68);
  } else if (target.goos === 'linux') {
    bytes.write('\x7fELF');
    bytes[4] = 2;
    bytes[5] = 1;
    bytes.writeUInt16LE(2, 16);
    bytes.writeUInt16LE(target.cpu === 'x64' ? 62 : 183, 18);
  } else {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(target.cpu === 'x64' ? 0x01000007 : 0x0100000c, 4);
    bytes.writeUInt32LE(2, 12);
  }
  return bytes;
}

function archivePath(root, target) {
  return path.join(root, 'dist', `omo-webchat_${target.goos}_${target.goarch}.${target.goos === 'windows' ? 'zip' : 'tar.gz'}`);
}

function writeArchive(root, target, mutate = () => {}) {
  const payload = fs.mkdtempSync(path.join(root, 'payload-'));
  try {
    const name = `omo-webchat${target.goos === 'windows' ? '.exe' : ''}`;
    fs.writeFileSync(path.join(payload, name), binary(target), { mode: 0o755 });
    for (const notice of NOTICES) fs.copyFileSync(path.join(root, notice), path.join(payload, notice));
    mutate(payload, name);
    const archive = archivePath(root, target);
    fs.rmSync(archive, { force: true });
    const members = fs.readdirSync(payload);
    ok(target.goos === 'windows'
      ? run('zip', ['-q', '-r', '-y', archive, ...members], { cwd: payload })
      : run('tar', ['-czf', archive, ...members], { cwd: payload, env: { ...process.env, COPYFILE_DISABLE: '1' } }));
  } finally {
    fs.rmSync(payload, { recursive: true, force: true });
  }
}

function fingerprint(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
    const file = path.join(dir, entry.name);
    return [entry.name, entry.isDirectory() ? fingerprint(file) : crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')];
  });
}

let base;
test.before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-release-base-'));
  fs.mkdirSync(path.join(base, 'npm/platform'), { recursive: true });
  fs.mkdirSync(path.join(base, 'dist'));
  fs.mkdirSync(path.join(base, 'frontend'));
  fs.mkdirSync(path.join(base, 'tools'));
  fs.copyFileSync(path.join(REPO, 'npm/platform/generate.mjs'), path.join(base, 'npm/platform/generate.mjs'));
  fs.cpSync(path.join(REPO, 'npm/cli'), path.join(base, 'npm/cli'), { recursive: true });
  for (const notice of NOTICES) fs.writeFileSync(path.join(base, notice), `fixture copy: ${notice}\n`);
  fs.writeFileSync(path.join(base, 'dist/metadata.json'), JSON.stringify({ version: VERSION }));
  for (const target of TARGETS) writeArchive(base, target);
  for (const command of ['go', 'npm', 'goreleaser']) {
    fs.writeFileSync(path.join(base, 'tools', command), `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.BUILD_LOG, ${JSON.stringify(command + '\n')});process.exit(97);\n`, { mode: 0o755 });
  }
});
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-release-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(base, root, { recursive: true });
  return root;
}

function generate(root, args = ['--skip-build', '--version', VERSION]) {
  return run(process.execPath, [path.join(root, 'npm/platform/generate.mjs'), ...args], {
    cwd: root,
    env: { ...process.env, BUILD_LOG: path.join(root, 'build.log'), PATH: `${path.join(root, 'tools')}${path.delimiter}${process.env.PATH}` },
  });
}

function rejectsWithoutWrites(root, args) {
  const before = fingerprint(path.join(root, 'npm'));
  const result = generate(root, args);
  assert.equal(fs.existsSync(path.join(root, 'build.log')), false, 'release consumer invoked a build command');
  assert.notEqual(result.status, 0, `invalid release input accepted\n${result.stdout}`);
  assert.deepEqual(fingerprint(path.join(root, 'npm')), before, 'invalid release input modified packages');
}

for (const target of TARGETS) {
  test(`--skip-build rejects missing ${target.goos}/${target.goarch} archive without building`, (t) => {
    const root = fixture(t);
    fs.rmSync(archivePath(root, target));
    rejectsWithoutWrites(root);
  });
}

for (const version of ['', '1.2', 'v1.2.3', '01.2.3', '1.2.3-01', '1.2.3 rc', '--skip-build', '1.2.3\n', '1.2.3+build', '9007199254740992.2.3']) {
  test(`rejects malformed requested version ${JSON.stringify(version)}`, (t) => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'dist/metadata.json'), JSON.stringify({ version }));
    rejectsWithoutWrites(root, ['--skip-build', '--version', version]);
  });
}
test('rejects --version without a value', (t) => rejectsWithoutWrites(fixture(t), ['--skip-build', '--version']));

for (const [label, metadata] of [
  ['missing', null], ['invalid JSON', '{'], ['missing version', '{}'], ['invalid version', '{"version":"1.2"}'],
  ['non-string version', '{"version":123}'], ['mismatched version', '{"version":"1.2.3-rc.2"}'],
]) {
  test(`rejects ${label} release metadata`, (t) => {
    const root = fixture(t);
    const file = path.join(root, 'dist/metadata.json');
    if (metadata === null) fs.rmSync(file);
    else fs.writeFileSync(file, metadata);
    rejectsWithoutWrites(root);
  });
}

for (const notice of NOTICES) {
  test(`rejects missing root ${notice}`, (t) => {
    const root = fixture(t);
    fs.rmSync(path.join(root, notice));
    rejectsWithoutWrites(root);
  });
  for (const change of ['missing', 'mismatched']) {
    test(`rejects ${change} archive ${notice}`, (t) => {
      const root = fixture(t);
      writeArchive(root, TARGETS[5], (payload) => {
        const file = path.join(payload, notice);
        if (change === 'missing') fs.rmSync(file);
        else fs.writeFileSync(file, 'different input copy\n');
      });
      rejectsWithoutWrites(root);
    });
  }
}

for (const target of [TARGETS[0], TARGETS[2], TARGETS[5]]) {
  for (const change of ['missing', 'empty', 'wrong architecture', 'wrong format', 'duplicate', 'symlink']) {
    test(`rejects ${change} ${target.goos} executable payload`, (t) => {
      const root = fixture(t);
      writeArchive(root, target, (payload, name) => {
        const file = path.join(payload, name);
        if (change === 'missing') fs.rmSync(file);
        if (change === 'empty') fs.writeFileSync(file, '');
        if (change === 'wrong architecture') fs.writeFileSync(file, binary({ ...target, cpu: target.cpu === 'x64' ? 'arm64' : 'x64' }));
        if (change === 'wrong format') fs.writeFileSync(file, Buffer.alloc(128));
        if (change === 'duplicate') {
          fs.mkdirSync(path.join(payload, 'nested'));
          fs.copyFileSync(file, path.join(payload, 'nested', name));
        }
        if (change === 'symlink') {
          fs.renameSync(file, path.join(payload, 'other'));
          fs.symlinkSync('other', file);
        }
      });
      rejectsWithoutWrites(root);
    });
  }
}

test('derives the exact version from metadata when no --version is given', (t) => {
  const root = fixture(t);
  ok(generate(root, ['--skip-build']));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'npm/cli/package.json'))).version, VERSION);
});

test('ships six exact payloads, package entrypoints, metadata and both notices in all seven npm tarballs', (t) => {
  const root = fixture(t);
  ok(generate(root));
  const cli = JSON.parse(fs.readFileSync(path.join(root, 'npm/cli/package.json')));
  assert.deepEqual(Object.keys(cli.optionalDependencies).sort(), TARGETS.map((target) => `omo-webchat-${target.osNode === 'win32' ? 'windows' : target.osNode}-${target.cpu}`).sort());
  assert.deepEqual(Object.values(cli.optionalDependencies), Array(6).fill(VERSION));
  const dirs = [path.join(root, 'npm/cli')];
  for (const target of TARGETS) {
    const dir = path.join(root, 'npm/platform', `${target.osNode}-${target.cpu}`);
    dirs.push(dir);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
    assert.equal(manifest.name, `omo-webchat-${target.osNode === 'win32' ? 'windows' : target.osNode}-${target.cpu}`);
    assert.deepEqual(manifest.os, [target.osNode]);
    assert.deepEqual(manifest.cpu, [target.cpu]);
    const exe = path.join(dir, 'exe', `omo-webchat-bin${target.goos === 'windows' ? '.exe' : ''}`);
    assert.equal(require(path.join(dir, 'index.js')), fs.realpathSync(exe));
    assert.deepEqual(fs.readFileSync(exe), binary(target));
    fs.accessSync(exe, fs.constants.X_OK);
  }
  const npmCli = [
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.join(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ].find((file) => fs.existsSync(file));
  assert.ok(npmCli, 'npm CLI must be installed beside Node');
  const env = { ...process.env, npm_config_cache: path.join(root, 'cache'), npm_config_userconfig: path.join(root, 'user.npmrc'), npm_config_globalconfig: path.join(root, 'global.npmrc'), npm_config_update_notifier: 'false' };
  fs.writeFileSync(env.npm_config_userconfig, '');
  fs.writeFileSync(env.npm_config_globalconfig, '');
  for (const dir of dirs) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
    assert.equal(manifest.version, VERSION);
    assert.equal(manifest.license, 'MIT');
    assert.equal(manifest.repository, 'https://github.com/DevNewbie1826/omo-webchat');
    assert.equal(manifest.scripts?.install, undefined);
    assert.equal(manifest.scripts?.postinstall, undefined);
    const [packed] = Object.values(JSON.parse(ok(run(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', root], { cwd: dir, env }))));
    const tarball = path.join(root, packed.filename);
    for (const notice of NOTICES) {
      assert.ok(manifest.files.includes(notice));
      assert.deepEqual(fs.readFileSync(path.join(dir, notice)), fs.readFileSync(path.join(root, notice)));
      assert.equal(ok(run('tar', ['-xOf', tarball, `package/${notice}`])), fs.readFileSync(path.join(root, notice), 'utf8'));
    }
    for (const file of packed.files.filter((file) => file.path.startsWith('exe/'))) {
      const bytes = run('tar', ['-xOf', tarball, `package/${file.path}`], { encoding: null });
      ok(bytes);
      assert.deepEqual(bytes.stdout, fs.readFileSync(path.join(dir, file.path)));
    }
  }
  const before = fingerprint(path.join(root, 'npm'));
  ok(generate(root));
  assert.deepEqual(fingerprint(path.join(root, 'npm')), before, 'same release inputs must generate identical package trees');
});
