import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const targets = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64'];
export const version = '1.2.3-rc.1';
export function sync(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
export function isolated(root) {
  const env = {
    PATH: process.env.PATH, HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC } : {}),
    RELEASE_NPM_CLI: process.env.RELEASE_NPM_CLI,
    npm_config_cache: path.join(root, 'cache'), npm_config_userconfig: path.join(root, 'user.npmrc'),
    npm_config_globalconfig: path.join(root, 'global.npmrc'), npm_config_update_notifier: 'false',
    npm_config_fetch_retries: '0', npm_config_fetch_timeout: '10000',
    npm_config_registry: 'http://127.0.0.1:1', npm_config_audit: 'false', npm_config_fund: 'false',
    COPYFILE_DISABLE: '1',
  };
  fs.writeFileSync(env.npm_config_userconfig, '');
  fs.writeFileSync(env.npm_config_globalconfig, '');
  return env;
}
export async function command(root, args, env = isolated(root)) {
  const child = spawn(process.execPath, [path.join(root, 'npm/release.mjs'), ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', (s) => { stdout += s; });
  child.stderr.setEncoding('utf8').on('data', (s) => { stderr += s; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  try {
    const [code, signal] = await once(child, 'close');
    assert.equal(signal, null, `deadline exceeded: ${stdout}\n${stderr}`);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}
export function ok(result) {
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}
export function fixture(t, releaseVersion = version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-delivery-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false);
    t.diagnostic('cleanup: isolated package tree, HOME, npm config/cache removed; client close awaited');
  });
  fs.cpSync(path.join(repo, 'npm'), path.join(root, 'npm'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist'));
  // Read-only binding to the real source HEAD; tests never create commits/tags.
  fs.writeFileSync(path.join(root, '.git'), `gitdir: ${sync('git', ['rev-parse', '--absolute-git-dir'], { cwd: repo })}\n`);
  const sourceCommit = sync('git', ['rev-parse', 'HEAD'], { cwd: repo });
  fs.writeFileSync(path.join(root, 'dist/metadata.json'), JSON.stringify({ version: releaseVersion, commit: sourceCommit }));
  for (const notice of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(repo, notice), path.join(root, notice));
  for (const target of targets) {
    const [osNode, cpu] = target.split('-');
    const goos = osNode === 'win32' ? 'windows' : osNode;
    const goarch = cpu === 'x64' ? 'amd64' : cpu;
    const payload = path.join(root, 'payload');
    fs.mkdirSync(payload);
    const bytes = Buffer.alloc(128); // Header fixtures only: native application proof is a separate lane.
    if (osNode === 'win32') {
      bytes.write('MZ'); bytes.writeUInt32LE(64, 0x3c); bytes.write('PE\0\0', 64); bytes.writeUInt16LE(cpu === 'x64' ? 0x8664 : 0xaa64, 68);
    } else if (osNode === 'linux') {
      bytes.write('\x7fELF'); bytes[4] = 2; bytes[5] = 1; bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(cpu === 'x64' ? 62 : 183, 18);
    } else {
      bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(cpu === 'x64' ? 0x01000007 : 0x0100000c, 4); bytes.writeUInt32LE(2, 12);
    }
    fs.writeFileSync(path.join(payload, `omo-webchat${osNode === 'win32' ? '.exe' : ''}`), bytes, { mode: 0o755 });
    for (const notice of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(root, notice), path.join(payload, notice));
    const archive = path.join(root, 'dist', `omo-webchat_${goos}_${goarch}.${osNode === 'win32' ? 'zip' : 'tar.gz'}`);
    sync(osNode === 'win32' ? 'zip' : 'tar', osNode === 'win32' ? ['-q', archive, ...fs.readdirSync(payload)] : ['-czf', archive, ...fs.readdirSync(payload)], { cwd: payload, env: { ...process.env, COPYFILE_DISABLE: '1' } });
    fs.rmSync(payload, { recursive: true });
  }
  return { root, sourceCommit, out: path.join(root, 'packed'), env: isolated(root) };
}
export function manifest(ctx) { return JSON.parse(fs.readFileSync(path.join(ctx.out, 'manifest.json'))); }
export function save(ctx, value) { fs.writeFileSync(path.join(ctx.out, 'manifest.json'), JSON.stringify(value)); }
