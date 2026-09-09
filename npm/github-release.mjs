#!/usr/bin/env node
// Publication-only helper: immutable asset resume, draft until every byte agrees.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const SELF = fileURLToPath(import.meta.url);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function check(value, message) { if (!value) throw new Error(message); }

export async function publishGitHub(manifestFile, {
  apiURL = 'https://api.github.com', repository, tag, token,
  verifier = fileURLToPath(new URL('./release.mjs', import.meta.url)), env = process.env,
}) {
  check(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'Invalid GitHub repository');
  check(token, 'GitHub publication credential missing');
  await exec(process.execPath, [verifier, 'verify', '--manifest', manifestFile], { env, timeout: 120_000 });
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  check(tag === `v${manifest.version}`, 'GitHub tag/version mismatch');
  const api = new URL(apiURL);
  check(api.origin === 'https://api.github.com' || (api.protocol === 'http:' && api.hostname === '127.0.0.1'), 'Unexpected GitHub API origin');
  const base = new URL(`/repos/${repository}/releases`, api).href;
  async function request(url, { method = 'GET', body, binary = false, absent = false } = {}) {
    const response = await fetch(url, {
      method, signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${token}`, accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' } : {}) },
      body: body && (Buffer.isBuffer(body) ? body : JSON.stringify(body)),
    });
    if (absent && response.status === 404) { await response.body?.cancel(); return undefined; }
    check(response.ok, `GitHub ${method} HTTP ${response.status}`);
    return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
  }
  // Capture and recheck every local asset before any API write.
  const files = [];
  for (const entry of manifest.archives) {
    const bytes = await readFile(path.resolve(path.dirname(manifestFile), entry.file));
    check(sha256(bytes) === entry.sha256, `Local asset changed after verification: ${entry.file}`);
    files.push({ ...entry, name: path.basename(entry.file), bytes });
  }
  let release = await request(`${base}/tags/${encodeURIComponent(tag)}`, { absent: true });
  if (!release) {
    // The by-tag endpoint excludes drafts. Authenticated release listings
    // include them for this contents:write caller; paginate without replacing
    // an accepted draft after a dropped upload/create response.
    for (let page = 1; !release; page++) {
      const releases = await request(`${base}?per_page=100&page=${page}`);
      check(Array.isArray(releases), 'Invalid GitHub release listing');
      const matches = releases.filter((candidate) => candidate.tag_name === tag);
      check(matches.length <= 1, 'Duplicate GitHub releases for tag');
      release = matches[0];
      if (releases.length < 100) break;
    }
  }
  const existing = new Set();
  if (release) {
    check(release.tag_name === tag && release.prerelease === manifest.version.includes('-') && Array.isArray(release.assets), 'GitHub release metadata mismatch');
    for (const asset of release.assets) {
      const entry = files.find((file) => file.name === asset.name);
      check(entry && !existing.has(asset.name) && Number.isSafeInteger(asset.id), 'Unexpected or duplicate GitHub asset');
      const bytes = await request(`${base}/assets/${asset.id}`, { binary: true });
      check(asset.state === 'uploaded' && asset.size === entry.bytes.length && sha256(bytes) === entry.sha256, `GitHub asset integrity mismatch: ${asset.name}`);
      existing.add(asset.name);
    }
    check(release.draft || existing.size === files.length, 'Published GitHub release has incomplete assets; refusing to modify a public release');
  }
  if (!release) {
    release = await request(base, { method: 'POST', body: { tag_name: tag, target_commitish: manifest.sourceCommit,
      name: tag, draft: true, prerelease: manifest.version.includes('-'), body: `Release ${tag}\n\nSource: ${manifest.sourceCommit}` } });
  }
  check(Number.isSafeInteger(release.id), 'Invalid GitHub release ID');
  const upload = new URL(release.upload_url.replace(/\{.*\}$/, ''));
  check(upload.origin === (api.origin === 'https://api.github.com' ? 'https://uploads.github.com' : api.origin), 'Unexpected GitHub upload origin');
  for (const entry of files) {
    if (existing.has(entry.name)) { console.log(`resume GitHub asset: ${entry.name}`); continue; }
    upload.search = new URLSearchParams({ name: entry.name }).toString();
    const asset = await request(upload, { method: 'POST', body: entry.bytes });
    check(Number.isSafeInteger(asset.id) && asset.name === entry.name && asset.state === 'uploaded' && asset.size === entry.bytes.length, `GitHub upload metadata mismatch: ${entry.name}`);
    check(sha256(await request(`${base}/assets/${asset.id}`, { binary: true })) === entry.sha256, `GitHub uploaded asset integrity mismatch: ${entry.name}`);
    console.log(`uploaded GitHub asset: ${entry.name}`);
  }
  if (release.draft) {
    const published = await request(`${base}/${release.id}`, { method: 'PATCH', body: { draft: false } });
    check(published.draft === false && published.tag_name === tag, 'GitHub release publication not confirmed');
  }
  console.log(`GitHub release verified: ${tag} (${manifest.sourceCommit})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  try {
    check(process.argv.length === 4 && process.argv[2] === '--manifest', 'Usage: github-release.mjs --manifest FILE');
    check(process.env.GITHUB_REF?.startsWith('refs/tags/v'), 'GitHub release requires a version tag');
    await publishGitHub(path.resolve(process.argv[3]), { repository: process.env.GITHUB_REPOSITORY,
      tag: process.env.GITHUB_REF.slice('refs/tags/'.length), token: process.env.GH_TOKEN });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
