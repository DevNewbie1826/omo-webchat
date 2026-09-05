'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const REPO = path.resolve(__dirname, '..');
const VERSION = '9.9.9-windows-contract';
const PE_AMD64 = 0x8664;
const PE_ARM64 = 0xaa64;
const TARGETS = [
  { osNode: 'darwin', cpuNode: 'arm64', goos: 'darwin', goarch: 'arm64' },
  { osNode: 'darwin', cpuNode: 'x64', goos: 'darwin', goarch: 'amd64' },
  { osNode: 'linux', cpuNode: 'x64', goos: 'linux', goarch: 'amd64' },
  { osNode: 'linux', cpuNode: 'arm64', goos: 'linux', goarch: 'arm64' },
  { osNode: 'win32', cpuNode: 'x64', goos: 'windows', goarch: 'amd64', ext: '.exe' },
  { osNode: 'win32', cpuNode: 'arm64', goos: 'windows', goarch: 'arm64', ext: '.exe' },
];
const NPX_ARGS = ['--password', 'secret with spaces', '--root', 'a & b; $(literal)', 'quote"and\\slash', ''];
const AGENT_PATH = '/explicit/agent with spaces';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function fingerprint(dir) {
  const hashes = {};
  const walk = (current, rel) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next, key);
      else hashes[key] = sha256(fs.readFileSync(next));
    }
  };
  walk(dir, '');
  return hashes;
}

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralSize = centrals.reduce((n, buf) => n + buf.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

function makeTarGz(fileName, data) {
  const header = Buffer.alloc(512);
  Buffer.from(fileName).copy(header, 0, 0, 100);
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii');
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const pad = (512 - (data.length % 512)) % 512;
  return zlib.gzipSync(Buffer.concat([header, data, Buffer.alloc(pad), Buffer.alloc(1024)]));
}

function peMachine(buf) {
  assert.equal(buf.subarray(0, 2).toString('binary'), 'MZ');
  const peOffset = buf.readUInt32LE(0x3c);
  assert.equal(buf.subarray(peOffset, peOffset + 4).toString('binary'), 'PE\0\0');
  return buf.readUInt16LE(peOffset + 4);
}

function resolveNpmBin(fileName) {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', fileName),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', fileName),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`${fileName} not found next to ${process.execPath}`);
}

function run(command, args, options = {}) {
  const { expected = 0, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    env: process.env,
    ...spawnOptions,
  });
  console.log(`COMMAND=${JSON.stringify([command, ...args])} exit=${result.status}`);
  if (result.error) throw result.error;
  if (result.status !== expected) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status}, expected ${expected}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

function npm(args, options) {
  return run(process.execPath, [resolveNpmBin('npm-cli.js'), ...args], options);
}

function npx(args, options) {
  return run(process.execPath, [resolveNpmBin('npx-cli.js'), ...args], options);
}

function isolatedEnv(work) {
  return {
    ...process.env,
    COPYFILE_DISABLE: '1',
    npm_config_cache: path.join(work, 'npm-cache'),
    npm_config_userconfig: path.join(work, 'user.npmrc'),
    npm_config_globalconfig: path.join(work, 'global.npmrc'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_loglevel: 'error',
  };
}

function writeArchives(distDir, binaries, { swapWindows = false } = {}) {
  fs.mkdirSync(distDir, { recursive: true });
  let winX64 = binaries.get('win32-x64');
  let winArm64 = binaries.get('win32-arm64');
  if (swapWindows) {
    const tmp = winX64;
    winX64 = winArm64;
    winArm64 = tmp;
  }
  for (const target of TARGETS) {
    const label = `${target.osNode}-${target.cpuNode}`;
    const data = label === 'win32-x64' ? winX64 : label === 'win32-arm64' ? winArm64 : binaries.get(label);
    const archive = path.join(
      distDir,
      target.goos === 'windows'
        ? `omo-webchat_${target.goos}_${target.goarch}.zip`
        : `omo-webchat_${target.goos}_${target.goarch}.tar.gz`,
    );
    if (target.goos === 'windows') {
      const zipPath = target.goarch === 'arm64' ? 'nested/omo-webchat.exe' : 'omo-webchat.exe';
      fs.writeFileSync(archive, makeZip([{ name: zipPath, data }]));
    } else {
      fs.writeFileSync(archive, makeTarGz('omo-webchat', data));
    }
  }
}

function copyGeneratorTree(workRepo) {
  fs.cpSync(path.join(REPO, 'npm'), path.join(workRepo, 'npm'), { recursive: true });
  assert.equal(
    sha256(fs.readFileSync(path.join(workRepo, 'npm/platform/generate.mjs'))),
    sha256(fs.readFileSync(path.join(REPO, 'npm/platform/generate.mjs'))),
  );
  assert.equal(sha256(fs.readFileSync(path.join(workRepo, 'npm/cli/cli.js'))), sha256(fs.readFileSync(path.join(REPO, 'npm/cli/cli.js'))));
}

function generatePackages(workRepo, binaries, options) {
  writeArchives(path.join(workRepo, 'dist'), binaries, options);
  run(process.execPath, [path.join(workRepo, 'npm/platform/generate.mjs'), '--skip-build', '--version', VERSION], {
    cwd: workRepo,
    env: isolatedEnv(path.dirname(workRepo)),
  });
}

function binName(target) {
  return `omo-webchat-bin${target.ext ?? ''}`;
}

function assertGeneratedContract(workRepo, binaries) {
  const cliManifest = JSON.parse(fs.readFileSync(path.join(workRepo, 'npm/cli/package.json'), 'utf8'));
  assert.equal(cliManifest.version, VERSION);
  assert.equal(Object.keys(cliManifest.optionalDependencies).length, TARGETS.length);
  for (const target of TARGETS) {
    const label = `${target.osNode}-${target.cpuNode}`;
    const pkgDir = path.join(workRepo, 'npm/platform', label);
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const exe = binName(target);
    const shipped = fs.readFileSync(path.join(pkgDir, 'exe', exe));
    assert.equal(manifest.name, `omo-webchat-${label}`);
    assert.equal(manifest.version, VERSION);
    assert.equal(cliManifest.optionalDependencies[manifest.name], VERSION, `${manifest.name} optional dependency is not in lockstep`);
    assert.deepEqual(manifest.os, [target.osNode]);
    assert.deepEqual(manifest.cpu, [target.cpuNode]);
    assert.equal(shipped.equals(binaries.get(label)), true, `${label} shipped bytes differ from archive fixture`);
    assert.equal(path.basename(requireUncached(path.join(pkgDir, 'index.js'))), exe);
    assert.match(manifest.scripts.prepack, new RegExp(`exe/${exe.replace('.', '\\.')}`));
    if (target.osNode === 'win32') {
      assert.equal(exe, 'omo-webchat-bin.exe');
      const machine = peMachine(shipped);
      const expectedMachine = target.cpuNode === 'x64' ? PE_AMD64 : PE_ARM64;
      assert.equal(machine, expectedMachine, `${label} PE machine ${machine.toString(16)} != ${expectedMachine.toString(16)}`);
      console.log(
        `PACK_RECEIPT=${JSON.stringify({
          package: manifest.name,
          version: VERSION,
          member: `package/exe/${exe}`,
          sha256: sha256(shipped),
          pe_machine: `0x${machine.toString(16)}`,
        })}`,
      );
    }
  }
  assert.notEqual(sha256(binaries.get('win32-x64')), sha256(binaries.get('win32-arm64')));
}

function requireUncached(filePath) {
  const resolved = require.resolve(filePath);
  delete require.cache[resolved];
  return require(resolved);
}

function tarList(archive) {
  return run('tar', ['-tzf', archive]).stdout.split(/\r?\n/).filter(Boolean);
}

function tarExtract(archive, member) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-tar-x-'));
  try {
    run('tar', ['-xzf', archive, '-C', dir, member]);
    return fs.readFileSync(path.join(dir, ...member.split('/')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function packPackages(workRepo, tarballDir, env) {
  fs.mkdirSync(tarballDir, { recursive: true });
  const packed = {};
  for (const target of TARGETS) {
    const label = `${target.osNode}-${target.cpuNode}`;
    const pkgDir = path.join(workRepo, 'npm/platform', label);
    const filename = npm(['pack', '--silent', '--pack-destination', tarballDir], { cwd: pkgDir, env }).stdout.trim();
    const tarball = path.join(tarballDir, filename);
    packed[manifestName(label)] = tarball;
    const exe = binName(target);
    const members = tarList(tarball);
    assert.ok(members.includes(`package/exe/${exe}`), `${label} packed tarball missing package/exe/${exe}`);
    if (target.osNode === 'win32') {
      assert.ok(!members.includes('package/exe/omo-webchat-bin'));
    }
    const packedBytes = tarExtract(tarball, `package/exe/${exe}`);
    assert.equal(packedBytes.equals(fs.readFileSync(path.join(pkgDir, 'exe', exe))), true);
  }
  const cliFilename = npm(['pack', '--silent', '--pack-destination', tarballDir], {
    cwd: path.join(workRepo, 'npm/cli'),
    env,
  }).stdout.trim();
  packed.cli = path.join(tarballDir, cliFilename);
  const cliPacked = JSON.parse(tarExtract(packed.cli, 'package/package.json').toString('utf8'));
  for (const target of TARGETS) {
    assert.equal(cliPacked.optionalDependencies[`omo-webchat-${target.osNode}-${target.cpuNode}`], VERSION);
  }
  return packed;
}

function manifestName(label) {
  return `omo-webchat-${label}`;
}

function hostTarget() {
  return TARGETS.find((target) => target.osNode === process.platform && target.cpuNode === process.arch);
}

function expectedGoArch(cpuNode) {
  return cpuNode === 'x64' ? 'amd64' : cpuNode;
}

function installHostPackages(project, packed, env) {
  const host = hostTarget();
  assert.ok(host, `unsupported host ${process.platform}-${process.arch}`);
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'npm-contract-host', version: '1.0.0', private: true }));
  const args = [
    'install',
    '--offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    packed[manifestName(`${host.osNode}-${host.cpuNode}`)],
    packed.cli,
  ];
  assert.ok(!args.includes('--force'));
  npm(args, { cwd: project, env });
}

function invokeNpx(project, args, env, expected) {
  return npx(['--offline', '--no-install', 'omo-webchat', ...args], {
    cwd: project,
    env: { ...env, CHAT_PI_BINARY: AGENT_PATH },
    expected,
  });
}

function parseProbe(stdout) {
  const line = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith('{') && entry.endsWith('}'));
  assert.ok(line, `probe JSON missing from stdout:\n${stdout}`);
  return JSON.parse(line);
}

function assertNativeNpx(project, env) {
  const host = hostTarget();
  const argvResult = invokeNpx(project, NPX_ARGS, env, 0);
  const receipt = parseProbe(argvResult.stdout);
  assert.deepEqual(receipt.args, NPX_ARGS, 'npx argv receipt');
  assert.equal(receipt.agent, AGENT_PATH, 'CHAT_PI_BINARY receipt');
  assert.equal(receipt.os, host.goos);
  assert.equal(receipt.arch, expectedGoArch(host.cpuNode));
  console.log(`NPX_ARGV_RECEIPT=${JSON.stringify(receipt)}`);
  const exitResult = invokeNpx(project, ['--exit-seven'], env, 7);
  assert.equal(exitResult.status, 7, 'npx nonzero exit');
  console.log(`NPX_EXIT_RECEIPT=${JSON.stringify({ status: exitResult.status, stdout: exitResult.stdout.trim() })}`);
}

function mutateOnce(source, pattern, replacement) {
  const next = source.replace(pattern, replacement);
  assert.notEqual(next, source, `mutation ${pattern} did not change wrapper`);
  return next;
}

function buildProbes(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const binaries = new Map();
  for (const target of TARGETS) {
    const label = `${target.osNode}-${target.cpuNode}`;
    const dest = path.join(binDir, `${target.goos}-${target.goarch}${target.goos === 'windows' ? '.exe' : ''}`);
    run('go', ['build', '-trimpath', '-o', dest, path.join(REPO, 'test/npm_argv_probe')], {
      cwd: REPO,
      env: { ...process.env, CGO_ENABLED: '0', GOOS: target.goos, GOARCH: target.goarch },
    });
    const data = fs.readFileSync(dest);
    binaries.set(label, data);
    if (target.osNode === 'win32') {
      assert.equal(peMachine(data), target.cpuNode === 'x64' ? PE_AMD64 : PE_ARM64);
    }
  }
  return binaries;
}

test('archive to packed npx contract', { timeout: 180_000 }, async (t) => {
  const before = fingerprint(path.join(REPO, 'npm'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-npm-win-'));
  t.after(() => {
    fs.rmSync(work, { recursive: true, force: true });
    assert.deepEqual(fingerprint(path.join(REPO, 'npm')), before);
  });
  fs.writeFileSync(path.join(work, 'user.npmrc'), '');
  fs.writeFileSync(path.join(work, 'global.npmrc'), '');
  const env = isolatedEnv(work);
  const binaries = buildProbes(path.join(work, 'binaries'));
  const workRepo = path.join(work, 'repo');
  fs.mkdirSync(workRepo);
  copyGeneratorTree(workRepo);
  generatePackages(workRepo, binaries);
  assert.deepEqual(fingerprint(path.join(REPO, 'npm')), before, 'generator wrote tracked npm files');

  await t.test('unmodified generator ships exact bytes, PE machines, exe names, and version lockstep', () => {
    assertGeneratedContract(workRepo, binaries);
  });

  const tarballs = path.join(work, 'tarballs');
  const packed = packPackages(workRepo, tarballs, env);
  await t.test('npm pack keeps Windows exe layout and other target archives', () => {
    for (const target of TARGETS) {
      const tarball = packed[manifestName(`${target.osNode}-${target.cpuNode}`)];
      assert.ok(tarball);
      assert.equal(fs.existsSync(tarball), true);
      const exe = binName(target);
      const members = tarList(tarball);
      assert.ok(members.includes(`package/exe/${exe}`), `${target.osNode}-${target.cpuNode} packed tarball missing package/exe/${exe}`);
      assert.equal(tarExtract(tarball, `package/exe/${exe}`).equals(binaries.get(`${target.osNode}-${target.cpuNode}`)), true);
    }
    assert.equal(fs.existsSync(packed.cli), true);
  });

  await t.test('prepack rejects a missing Windows binary', () => {
    const pkgDir = path.join(work, 'missing-bin', 'win32-x64');
    fs.cpSync(path.join(workRepo, 'npm/platform/win32-x64'), pkgDir, { recursive: true });
    fs.rmSync(path.join(pkgDir, 'exe/omo-webchat-bin.exe'));
    const result = npm(['pack', '--silent', '--pack-destination', path.join(work, 'missing-bin')], {
      cwd: pkgDir,
      env,
      expected: 1,
    });
    assert.match(`${result.stdout}\n${result.stderr}`, /expected executable exe\/omo-webchat-bin\.exe is missing or not executable/);
  });

  const project = path.join(work, 'install root');
  await t.test('native npm install and npx preserve argv, CHAT_PI_BINARY, and nonzero exit', () => {
    console.log(`HOST_NPX_SURFACE=${process.platform}-${process.arch}`);
    installHostPackages(project, packed, env);
    const hostPkg = `omo-webchat-${process.platform}-${process.arch}`;
    assert.equal(fs.existsSync(path.join(project, 'node_modules', hostPkg, 'package.json')), true);
    assert.equal(
      fs.existsSync(path.join(project, 'node_modules/omo-webchat-win32-x64/package.json')),
      process.platform === 'win32' && process.arch === 'x64',
    );
    assert.equal(
      fs.existsSync(path.join(project, 'node_modules/omo-webchat-win32-arm64/package.json')),
      process.platform === 'win32' && process.arch === 'arm64',
    );
    assertNativeNpx(project, env);
  });

  await t.test('swapped Windows ZIP bytes fail PE and exact-byte contract', () => {
    const mutRepo = path.join(work, 'mutation-swap');
    fs.mkdirSync(mutRepo);
    copyGeneratorTree(mutRepo);
    generatePackages(mutRepo, binaries, { swapWindows: true });
    assert.throws(() => assertGeneratedContract(mutRepo, binaries), /PE machine|shipped bytes differ/);
  });

  await t.test('wrong Windows exe export fails the packed entrypoint contract', () => {
    const pkgDir = path.join(work, 'mutation-exe');
    fs.cpSync(path.join(workRepo, 'npm/platform/win32-x64'), pkgDir, { recursive: true });
    const indexPath = path.join(pkgDir, 'index.js');
    fs.writeFileSync(indexPath, mutateOnce(fs.readFileSync(indexPath, 'utf8'), 'omo-webchat-bin.exe', 'omo-webchat-bin'));
    assert.throws(() => {
      assert.equal(path.basename(requireUncached(indexPath)), 'omo-webchat-bin.exe');
    }, /omo-webchat-bin\.exe/);
  });

  await t.test('omitted optional dependency fails lockstep and native resolve', () => {
    const cliManifest = JSON.parse(fs.readFileSync(path.join(workRepo, 'npm/cli/package.json'), 'utf8'));
    const omitted = structuredClone(cliManifest);
    delete omitted.optionalDependencies['omo-webchat-win32-x64'];
    assert.throws(() => {
      assert.equal(omitted.optionalDependencies['omo-webchat-win32-x64'], VERSION, 'omo-webchat-win32-x64 optional dependency is not in lockstep');
    }, /optional dependency is not in lockstep/);

    const omitProject = path.join(work, 'mutation-omit');
    fs.mkdirSync(omitProject, { recursive: true });
    fs.writeFileSync(path.join(omitProject, 'package.json'), JSON.stringify({ name: 'omit-dep', version: '1.0.0', private: true }));
    npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', packed.cli], { cwd: omitProject, env });
    const result = npx(['--offline', '--no-install', 'omo-webchat', '--status'], {
      cwd: omitProject,
      env: { ...env, CHAT_PI_BINARY: AGENT_PATH },
      expected: 1,
    });
    assert.match(`${result.stdout}\n${result.stderr}`, /not installed|unsupported platform|binary not found/);
  });

  await t.test('wrapper dropping argv or swallowing exit fails native npx receipts', () => {
    const argvCli = path.join(work, 'mutation-argv-cli');
    fs.cpSync(path.join(workRepo, 'npm/cli'), argvCli, { recursive: true });
    const cliPath = path.join(argvCli, 'cli.js');
    fs.writeFileSync(cliPath, mutateOnce(fs.readFileSync(cliPath, 'utf8'), 'spawn(resolved.path, argv,', 'spawn(resolved.path, [],'));
    const argvPackDir = path.join(work, 'mutation-argv-tarballs');
    fs.mkdirSync(argvPackDir, { recursive: true });
    const argvTarball = path.join(
      argvPackDir,
      npm(['pack', '--silent', '--pack-destination', argvPackDir], { cwd: argvCli, env }).stdout.trim(),
    );
    const argvProject = path.join(work, 'mutation-argv');
    installHostPackages(argvProject, { ...packed, cli: argvTarball }, env);
    assert.throws(() => assertNativeNpx(argvProject, env), /npx argv receipt/);

    const exitCli = path.join(work, 'mutation-exit-cli');
    fs.cpSync(path.join(workRepo, 'npm/cli'), exitCli, { recursive: true });
    fs.writeFileSync(
      path.join(exitCli, 'cli.js'),
      mutateOnce(
        fs.readFileSync(path.join(exitCli, 'cli.js'), 'utf8'),
        "process.exitCode = typeof code === 'number' ? code : 1;",
        'process.exitCode = 0;',
      ),
    );
    const exitPackDir = path.join(work, 'mutation-exit-tarballs');
    fs.mkdirSync(exitPackDir, { recursive: true });
    const exitTarball = path.join(
      exitPackDir,
      npm(['pack', '--silent', '--pack-destination', exitPackDir], { cwd: exitCli, env }).stdout.trim(),
    );
    const exitProject = path.join(work, 'mutation-exit');
    installHostPackages(exitProject, { ...packed, cli: exitTarball }, env);
    assert.throws(() => assertNativeNpx(exitProject, env), /expected 7/);
  });
});
