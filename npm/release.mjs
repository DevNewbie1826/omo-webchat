#!/usr/bin/env node
// Build once, validate immutable bytes, then publish platforms before the wrapper.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64'];
const NOTICES = ['LICENSE', 'THIRD_PARTY_NOTICES.md'];
const ARCHIVES = TARGETS.map((target) => {
  const [os, cpu] = target.split('-');
  return `omo-webchat_${os === 'win32' ? 'windows' : os}_${cpu === 'x64' ? 'amd64' : cpu}.${os === 'win32' ? 'zip' : 'tar.gz'}`;
});
const NAMES = [...TARGETS.map((target) => `omo-webchat-${target}`), 'omo-webchat'];
const digest = (bytes, algorithm, encoding) => createHash(algorithm).update(bytes).digest(encoding);
const hashes = (bytes) => ({ sha256: digest(bytes, 'sha256', 'hex'), integrity: `sha512-${digest(bytes, 'sha512', 'base64')}` });
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function version(value) {
  const number = '(0|[1-9][0-9]*)';
  const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
  requireValue(typeof value === 'string' && new RegExp(`^${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?$`).test(value) &&
    value.split(/[.-]/).slice(0, 3).every((n) => Number.isSafeInteger(Number(n))), 'Invalid release version');
  return value;
}
async function run(executable, args, { cwd = ROOT, env = process.env, timeout = 120_000 } = {}) {
  const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  try {
    const [code, signal] = await once(child, 'close');
    requireValue(code === 0 && signal === null, `${path.basename(executable)} failed (${signal ?? code}): ${stderr || stdout}`);
    return stdout.trim();
  } finally { clearTimeout(timer); }
}
function npmCLI() {
  const candidates = [process.env.RELEASE_NPM_CLI,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  const file = candidates.find((file) => file && existsSync(file));
  requireValue(file, 'npm CLI not found; set RELEASE_NPM_CLI to npm/bin/npm-cli.js');
  return file;
}
async function npm(args, options) { return run(process.execPath, [npmCLI(), ...args], options); }
async function sourceBinding(value, releaseVersion) {
  requireValue(typeof value === 'string' && /^[a-f0-9]{40}$/.test(value), 'Invalid sourceCommit');
  requireValue(value === await run('git', ['rev-parse', 'HEAD']), 'sourceCommit differs from checked-out source');
  if (process.env.GITHUB_SHA) requireValue(value === process.env.GITHUB_SHA, 'sourceCommit differs from workflow source');
  if (process.env.GITHUB_REF?.startsWith('refs/tags/')) {
    requireValue(process.env.GITHUB_REF === `refs/tags/v${releaseVersion}`, 'Tag/version mismatch');
    requireValue(value === await run('git', ['rev-parse', `${process.env.GITHUB_REF}^{commit}`]), 'Tag/sourceCommit mismatch');
  }
}
async function record(directory, file) { return { file, ...hashes(await fs.readFile(path.join(directory, file))) }; }

async function pack(out) {
  requireValue(!existsSync(out), 'Output already exists; retain immutable artifacts and choose a new directory');
  const metadata = JSON.parse(await fs.readFile(path.join(ROOT, 'dist/metadata.json'), 'utf8'));
  const releaseVersion = version(metadata.version);
  await sourceBinding(metadata.commit, releaseVersion);
  await fs.mkdir(path.dirname(out), { recursive: true });
  const staging = await fs.mkdtemp(path.join(path.dirname(out), '.release-pack-'));
  try {
    const source = path.join(staging, 'source');
    const output = path.join(staging, 'output');
    await fs.mkdir(path.join(source, 'npm/platform'), { recursive: true });
    await fs.mkdir(path.join(output, 'archives'), { recursive: true });
    await fs.cp(path.join(ROOT, 'npm/cli'), path.join(source, 'npm/cli'), { recursive: true });
    await fs.copyFile(path.join(ROOT, 'npm/platform/generate.mjs'), path.join(source, 'npm/platform/generate.mjs'));
    await fs.cp(path.join(ROOT, 'dist'), path.join(source, 'dist'), { recursive: true });
    for (const notice of NOTICES) await fs.copyFile(path.join(ROOT, notice), path.join(source, notice));
    // The strict generator validates every archive before creating any package.
    await run(process.execPath, [path.join(source, 'npm/platform/generate.mjs'), '--skip-build', '--version', releaseVersion]);
    const packages = [];
    for (const name of NAMES) {
      const target = name === 'omo-webchat' ? undefined : name.slice('omo-webchat-'.length);
      const cwd = path.join(source, 'npm', target ? `platform/${target}` : 'cli');
      const packed = JSON.parse(await npm(['pack', '--json', '--pack-destination', output], { cwd }));
      requireValue(packed.length === 1 && packed[0].name === name && packed[0].version === releaseVersion, `npm pack identity mismatch: ${name}`);
      const file = packed[0].filename;
      requireValue(file === `${name}-${releaseVersion}.tgz`, `Unexpected npm tarball filename: ${name}`);
      const entry = { name, version: releaseVersion, ...await record(output, file) };
      requireValue(packed[0].integrity === entry.integrity, `npm pack integrity mismatch: ${name}`);
      if (target) { const [os, cpu] = target.split('-'); entry.platform = { os, cpu }; }
      packages.push(entry);
    }
    const archives = [];
    for (const file of [...ARCHIVES, ...NOTICES]) {
      await fs.copyFile(path.join(source, ARCHIVES.includes(file) ? 'dist' : '', file), path.join(output, 'archives', file));
      archives.push(await record(output, `archives/${file}`));
    }
    await fs.writeFile(path.join(output, 'archives/checksums.txt'), archives.map((a) => `${a.sha256}  ${path.basename(a.file)}\n`).join(''));
    archives.push(await record(output, 'archives/checksums.txt'));
    const manifest = { version: releaseVersion, sourceCommit: metadata.commit, packages, archives };
    await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await validate(path.join(output, 'manifest.json'));
    await fs.rename(output, out);
    console.log(JSON.stringify({ manifest: path.join(out, 'manifest.json'), version: releaseVersion, sourceCommit: metadata.commit, packages: packages.length }));
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
async function checkedFile(directory, entry, expectedFile) {
  requireValue(entry?.file === expectedFile, `Invalid artifact path: expected ${expectedFile}`);
  const file = path.join(directory, expectedFile);
  requireValue((await fs.lstat(file)).isFile(), `Artifact must be a regular file: ${expectedFile}`);
  const real = await fs.realpath(file);
  requireValue(real.startsWith(`${await fs.realpath(directory)}${path.sep}`), `Artifact escapes manifest directory: ${expectedFile}`);
  const actual = hashes(await fs.readFile(file));
  requireValue(entry.sha256 === actual.sha256 && entry.integrity === actual.integrity, `Artifact integrity mismatch: ${expectedFile}`);
  return file;
}
async function payload(file, entry, releaseVersion) {
  const members = (await run('tar', ['-tzf', file])).split(/\r?\n/);
  const binary = `exe/omo-webchat-bin${entry.platform?.os === 'win32' ? '.exe' : ''}`;
  const expected = ['package.json', ...NOTICES, ...(entry.platform ? ['index.js', binary] : ['cli.js', 'README.md'])].map((name) => `package/${name}`);
  requireValue(isDeepStrictEqual([...members].sort(), expected.sort()), `Invalid package payload members: ${entry.name}`);
  const listing = (await run('tar', ['-tvzf', file])).split(/\r?\n/);
  requireValue(listing.every((line) => line.startsWith('-')), `Package payload must contain regular files: ${entry.name}`);
  const pkg = JSON.parse(await run('tar', ['-xzOf', file, 'package/package.json']));
  requireValue(pkg.name === entry.name && pkg.version === releaseVersion && pkg.license === 'MIT', `Package payload identity mismatch: ${entry.name}`);
  requireValue(!pkg.private && !pkg.dependencies && !pkg.publishConfig, `Unexpected package publication metadata: ${entry.name}`);
  if (entry.platform) {
    requireValue(isDeepStrictEqual(pkg.os, [entry.platform.os]) && isDeepStrictEqual(pkg.cpu, [entry.platform.cpu]) &&
      pkg.main === 'index.js' && !pkg.optionalDependencies, `Package platform metadata mismatch: ${entry.name}`);
  } else {
    requireValue(!pkg.os && !pkg.cpu && isDeepStrictEqual(pkg.bin, { 'omo-webchat': 'cli.js' }) &&
      isDeepStrictEqual(pkg.optionalDependencies, Object.fromEntries(NAMES.slice(0, 6).map((name) => [name, releaseVersion]))), 'Wrapper dependency/entrypoint metadata mismatch');
  }
  return pkg;
}
async function validate(manifestFile) {
  const directory = path.dirname(path.resolve(manifestFile));
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  const releaseVersion = version(manifest.version);
  await sourceBinding(manifest.sourceCommit, releaseVersion);
  requireValue(Array.isArray(manifest.packages) && manifest.packages.length === 7, 'Expected exactly seven packages');
  requireValue(isDeepStrictEqual(manifest.packages.map((p) => p.name).sort(), [...NAMES].sort()), 'Invalid or duplicate package names');
  const packages = [];
  for (const name of NAMES) {
    const entry = manifest.packages.find((p) => p.name === name);
    requireValue(entry.version === releaseVersion, `Package version mismatch: ${name}`);
    const target = TARGETS.find((target) => name === `omo-webchat-${target}`);
    const expected = target ? { os: target.split('-')[0], cpu: target.split('-')[1] } : undefined;
    requireValue(isDeepStrictEqual(entry.platform, expected), `Invalid platform metadata: ${name}`);
    const file = await checkedFile(directory, entry, `${name}-${releaseVersion}.tgz`);
    packages.push({ ...entry, file, payload: await payload(file, entry, releaseVersion) });
  }
  const expectedArchives = [...ARCHIVES, ...NOTICES, 'checksums.txt'].map((name) => `archives/${name}`);
  requireValue(Array.isArray(manifest.archives) && isDeepStrictEqual(manifest.archives.map((a) => a.file).sort(), [...expectedArchives].sort()), 'Invalid release archive set');
  for (const file of expectedArchives) await checkedFile(directory, manifest.archives.find((a) => a.file === file), file);
  const expectedChecksums = manifest.archives.filter((a) => a.file !== 'archives/checksums.txt').map((a) => `${a.sha256}  ${path.basename(a.file)}\n`).join('');
  requireValue(await fs.readFile(path.join(directory, 'archives/checksums.txt'), 'utf8') === expectedChecksums, 'Release checksums mismatch');
  return { manifest, packages };
}
async function remote(registry, name) {
  const response = await fetch(new URL(encodeURIComponent(name), registry), { signal: AbortSignal.timeout(30_000), redirect: 'error', headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
  if (response.status === 404) { await response.body?.cancel(); return undefined; }
  requireValue(response.ok, `Registry preflight HTTP ${response.status}: ${name}`);
  return response.json();
}
function matching(document, entry, tag) {
  requireValue(document && document.name === entry.name && document.versions && typeof document.versions === 'object', `Invalid registry metadata: ${entry.name}`);
  const stored = document.versions[entry.version];
  if (!stored) return false;
  requireValue(stored.name === entry.name && stored.version === entry.version && stored.dist?.integrity === entry.integrity, `Remote immutable integrity/identity mismatch: ${entry.name}`);
  for (const field of ['os', 'cpu', 'optionalDependencies', 'bin']) requireValue(isDeepStrictEqual(stored[field], entry.payload[field]), `Remote payload metadata mismatch: ${entry.name}`);
  requireValue(document['dist-tags']?.[tag] === entry.version, `Existing ${entry.name}@${entry.version} does not have tag ${tag}; no dist-tag mutation was performed`);
  return true;
}
async function publish(manifestFile, tag, registry, provenance) {
  const { manifest, packages } = await validate(manifestFile);
  requireValue(tag === (manifest.version.includes('-') ? 'next' : 'latest'), 'Release version/tag mismatch: prereleases use next, stable uses latest');
  const endpoint = new URL(registry);
  requireValue(['https:', 'http:'].includes(endpoint.protocol) && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, 'Invalid registry URL');
  if (!endpoint.pathname.endsWith('/')) endpoint.pathname += '/';
  // Inspect every remote version before the first write, including the wrapper.
  const pending = [];
  for (const entry of packages) {
    const document = await remote(endpoint, entry.name);
    if (document === undefined || !matching(document, entry, tag)) pending.push(entry);
    else console.log(`resume: ${entry.name}@${entry.version} already matches (${tag})`);
  }
  // Snapshot validated inputs privately: subsequent input-file changes cannot
  // substitute bytes between preflight and npm opening the tarball.
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'omo-publish-'));
  try {
    for (const entry of pending) {
      const file = path.join(staging, path.basename(entry.file));
      await fs.copyFile(entry.file, file);
      requireValue(isDeepStrictEqual(hashes(await fs.readFile(file)), { sha256: entry.sha256, integrity: entry.integrity }), `Artifact changed after preflight: ${entry.name}`);
    }
    for (const entry of pending) {
      const args = ['publish', path.join(staging, path.basename(entry.file)), '--access', 'public', '--tag', tag, '--registry', endpoint.href,
        '--ignore-scripts', '--fetch-retries=0', '--fetch-timeout=30000', provenance ? '--provenance' : '--provenance=false'];
      await npm(args, { cwd: staging });
      const document = await remote(endpoint, entry.name);
      requireValue(document !== undefined && matching(document, entry, tag), `Publication was not confirmed: ${entry.name}`);
      console.log(`published: ${entry.name}@${entry.version} (${tag})`);
    }
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
function args(argv) {
  const [command, ...rest] = argv;
  const allowed = command === 'pack' ? ['--out'] : command === 'verify' ? ['--manifest'] : command === 'publish' ? ['--manifest', '--tag', '--registry', '--provenance'] : [];
  requireValue(allowed.length, 'Usage: release.mjs pack --out DIR | verify --manifest FILE | publish --manifest FILE --tag next|latest [--registry URL] [--provenance]');
  const values = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    requireValue(allowed.includes(key) && !Object.hasOwn(values, key), `Unknown or repeated argument: ${key}`);
    if (key === '--provenance') values[key] = true;
    else { requireValue(rest[i + 1] && !rest[i + 1].startsWith('--'), `Missing value: ${key}`); values[key] = rest[++i]; }
  }
  requireValue(command === 'pack' ? values['--out'] : values['--manifest'], 'Missing required artifact path');
  if (command === 'publish') requireValue(['next', 'latest'].includes(values['--tag']), 'Expected --tag next|latest');
  return { command, values };
}
try {
  const { command, values } = args(process.argv.slice(2));
  if (command === 'pack') await pack(path.resolve(values['--out']));
  if (command === 'verify') { const { manifest } = await validate(path.resolve(values['--manifest'])); console.log(JSON.stringify({ verified: true, version: manifest.version, sourceCommit: manifest.sourceCommit })); }
  if (command === 'publish') await publish(path.resolve(values['--manifest']), values['--tag'], values['--registry'] ?? 'https://registry.npmjs.org/', values['--provenance'] ?? false);
} catch (error) { console.error(error.message); process.exitCode = 1; }
