// Test-only, in-memory npm registry. Never forwards requests or records headers.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';

const exec = promisify(execFile);
const MAX_BODY = 128 * 1024 * 1024;
const hash = (bytes, algorithm, encoding) => createHash(algorithm).update(bytes).digest(encoding);

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'EBADPACKAGE' });
}

async function manifestFrom(bytes) {
  if (bytes.length > MAX_BODY) throw invalid('Tarball exceeds fixture limit');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'npm-registry-tar-'));
  try {
    const file = path.join(directory, 'package.tgz');
    await writeFile(file, bytes);
    // Only stream the manifest to stdout: never extract archive paths to disk.
    const { stdout } = await exec('tar', ['-xzOf', './package.tgz', 'package/package.json'], { cwd: directory, timeout: 10_000, maxBuffer: 1024 * 1024 });
    const manifest = JSON.parse(stdout);
    if (typeof manifest.name !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(manifest.name) ||
        typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
      throw invalid('Tarball must contain a named, versioned npm package');
    }
    return manifest;
  } catch (error) {
    if (error.status) throw error;
    throw invalid(`Cannot read package/package.json: ${error.message}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(invalid('Request exceeds fixture limit'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw invalid('Invalid JSON'); }
}

/**
 * packages is a Map<name, packument>; requests records {method,path,status}.
 * request events fire on arrival (the same record gains status on completion).
 * publish events fire after validation/storage, with {number,name,version,outcome}.
 * Seed order determines `latest` when several tarballs have the same name.
 * close() is idempotent and joins connections and in-flight archive readers.
 */
export async function createRegistry({ tarballs = [], failPublishAt, hidePublishedGets = 0 } = {}) {
  if (failPublishAt !== undefined && (!Number.isSafeInteger(failPublishAt.number) || failPublishAt.number < 1 ||
      !['reject', 'disconnect-after-store'].includes(failPublishAt.mode))) {
    throw new TypeError('failPublishAt must be {number: positive integer, mode: reject|disconnect-after-store}');
  }
  if (!Number.isSafeInteger(hidePublishedGets) || hidePublishedGets < 0) {
    throw new TypeError('hidePublishedGets must be a non-negative integer');
  }
  const requests = [];
  const packages = new Map();
  const events = new EventEmitter();
  const archives = new Map();
  // Simulated registry propagation delay: freshly stored versions stay
  // absent from the packument until it has been read hidePublishedGets
  // times, mirroring the real registry's eventual consistency.
  const concealed = new Map();
  const pending = new Set();
  let url;
  let publishNumber = 0;
  let failureFired = false;
  let closing;

  function store(manifest, bytes, tags) {
    const { name, version } = manifest;
    const existing = packages.get(name);
    if ((existing && Object.hasOwn(existing.versions, version))
      || (concealed.get(name) ?? []).some((entry) => entry.version === version)) {
      throw Object.assign(new Error('Version already exists'), { status: 409, code: 'EPUBLISHCONFLICT' });
    }
    const tarballPath = `/${name}/-/${name.split('/').at(-1)}-${version}.tgz`;
    const metadata = {
      ...manifest, _id: `${name}@${version}`,
      dist: {
        tarball: `${url}${tarballPath}`,
        shasum: hash(bytes, 'sha1', 'hex'),
        integrity: `sha512-${hash(bytes, 'sha512', 'base64')}`,
      },
    };
    const document = existing ?? { _id: name, name, versions: {}, 'dist-tags': {} };
    document.versions[version] = metadata;
    Object.assign(document['dist-tags'], tags);
    packages.set(name, document);
    archives.set(tarballPath, bytes);
    if (hidePublishedGets > 0) {
      delete document.versions[version];
      for (const tag of Object.keys(tags)) delete document['dist-tags'][tag];
      const entries = concealed.get(name) ?? [];
      entries.push({ version, metadata, tags, getsRemaining: hidePublishedGets });
      concealed.set(name, entries);
    }
  }

  function reply(response, record, status, body) {
    record.status = status;
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    response.writeHead(status, { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', 'content-length': bytes.length });
    response.end(bytes);
  }

  async function handle(request, response, record) {
    let route;
    try { route = decodeURIComponent(record.path); }
    catch { throw invalid('Invalid path encoding'); }
    if (request.method === 'GET' || request.method === 'HEAD') {
      const archive = archives.get(route);
      if (archive) return reply(response, record, 200, archive);
      const parts = route.slice(1).split('/');
      const name = parts.splice(0, route.startsWith('/@') ? 2 : 1).join('/');
      if (parts.length === 0 && concealed.has(name)) {
        const document = packages.get(name);
        const stillHidden = [];
        for (const entry of concealed.get(name)) {
          if (entry.getsRemaining > 0 || request.method !== 'GET') {
            if (request.method === 'GET' && entry.getsRemaining > 0) entry.getsRemaining -= 1;
            stillHidden.push(entry);
          } else if (document) {
            document.versions[entry.version] = entry.metadata;
            Object.assign(document['dist-tags'], entry.tags);
          }
        }
        if (stillHidden.length === 0) concealed.delete(name);
        else concealed.set(name, stillHidden);
      }
      const document = packages.get(name);
      let body = document;
      if (parts.length === 1 && document) {
        const version = Object.hasOwn(document['dist-tags'], parts[0]) ? document['dist-tags'][parts[0]] : parts[0];
        body = Object.hasOwn(document.versions, version) ? document.versions[version] : undefined;
      } else if (parts.length) body = undefined;
      return body ? reply(response, record, 200, body) : reply(response, record, 404, { error: 'E404', reason: 'Not found in local fixture' });
    }
    if (request.method !== 'PUT') return reply(response, record, 405, { error: 'EMETHOD', reason: 'Unsupported fixture method' });
    const name = route.slice(1);
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name)) {
      return reply(response, record, 404, { error: 'E404', reason: 'Unsupported fixture route' });
    }
    const number = ++publishNumber;
    const body = await readBody(request);
    const versions = Object.entries(body?.versions ?? {});
    const attachments = Object.entries(body?._attachments ?? {});
    if (body?.name !== name || versions.length !== 1 || attachments.length !== 1) throw invalid('Expected one version and one attachment for route name');
    const [version, metadata] = versions[0];
    const [filename, attachment] = attachments[0];
    if (filename !== `${name}-${version}.tgz` || typeof attachment?.data !== 'string') throw invalid('Invalid attachment');
    const bytes = Buffer.from(attachment.data, 'base64');
    if (attachment.data !== bytes.toString('base64') || attachment.length !== bytes.length) throw invalid('Attachment length or encoding mismatch');
    const manifest = await manifestFrom(bytes);
    if (manifest.name !== name || manifest.version !== version || metadata?.name !== name || metadata?.version !== version) throw invalid('Package identity mismatch');
    // These machine-consumed fields must describe the shipped manifest, not a
    // fabricated platform/dependency story supplied alongside its attachment.
    for (const field of ['os', 'cpu', 'optionalDependencies', 'dependencies', 'bin', 'engines']) {
      if (!isDeepStrictEqual(manifest[field], metadata[field])) throw invalid(`Package ${field} mismatch`);
    }
    if (metadata.dist?.integrity !== `sha512-${hash(bytes, 'sha512', 'base64')}` || metadata.dist?.shasum !== hash(bytes, 'sha1', 'hex')) throw invalid('Package integrity mismatch');
    const tags = body['dist-tags'];
    if (!tags || typeof tags !== 'object' || Array.isArray(tags) || !Object.keys(tags).length ||
        Object.entries(tags).some(([tag, target]) => !/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(tag) ||
          (target !== version && !Object.hasOwn(packages.get(name)?.versions ?? {}, target)))) throw invalid('Invalid dist-tags');
    const failure = !failureFired && failPublishAt?.number === number ? failPublishAt.mode : undefined;
    if (failure) failureFired = true;
    if (failure === 'reject') {
      events.emit('publish', { number, name, version, outcome: failure });
      return reply(response, record, 503, { error: 'E503', reason: 'Injected publication rejection' });
    }
    store(manifest, bytes, tags);
    events.emit('publish', { number, name, version, outcome: failure ?? 'stored' });
    if (failure === 'disconnect-after-store') {
      record.status = 'disconnected';
      request.socket.destroy();
      return;
    }
    reply(response, record, 201, { ok: true, id: name, rev: String(number) });
  }

  const server = http.createServer({ requestTimeout: 30_000, headersTimeout: 10_000, maxHeaderSize: 16 * 1024 }, (request, response) => {
    // Store only the path, never query strings, request bodies or credentials.
    const record = { method: request.method, path: request.url.split('?')[0] };
    requests.push(record);
    events.emit('request', record);
    const work = handle(request, response, record).catch((error) => {
      if (response.destroyed) {
        record.status = 'disconnected';
        record.error = error.code ?? 'EINTERNAL';
      } else {
        reply(response, record, error.status ?? 500, { error: error.code ?? 'EINTERNAL', reason: error.message });
      }
    });
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  // Bound incomplete requests as well as idle keep-alive connections.
  server.setTimeout(30_000, (socket) => socket.destroy());
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  async function close() {
    closing ??= (async () => {
      const joined = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      const disconnected = [...sockets].map((socket) => new Promise((resolve) => socket.once('close', resolve)));
      server.closeAllConnections();
      await joined;
      await Promise.all(disconnected);
      await Promise.all([...pending]);
    })();
    return closing;
  }

  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  url = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const tarball of tarballs) {
      const bytes = await readFile(tarball);
      const manifest = await manifestFrom(bytes);
      store(manifest, bytes, { latest: manifest.version });
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { url, requests, packages, events, close };
}
