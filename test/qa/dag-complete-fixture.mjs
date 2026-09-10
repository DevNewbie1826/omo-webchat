import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startTaskFixture } from './task-state-fixture.mjs';
import { confirmPortReleased, launchChild, snapshotAssets } from './dag-state-ordering.mjs';
import { bounded, expectedRun } from './dag-complete-controls.mjs';

export const root = resolve(import.meta.dirname, '../..');
export const driverPath = process.env.QA_PLAYWRIGHT ?? join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs');
export const chromePath = process.env.QA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const loadDriver = async () => (await import(pathToFileURL(driverPath).href)).chromium;
export const save = (dir, name, value) => writeFile(join(dir, name), JSON.stringify(value, null, 2) + '\n');
export function transcript() {
  return Array.from({ length: 100 }, (_, index) => ({ id: `dag-transcript-${index}`, parentId: index ? `dag-transcript-${index - 1}` : null,
    type: 'message', message: { role: index % 2 ? 'assistant' : 'user', content: `dag-transcript-${index}\n${'Long owned transcript content. '.repeat(70)}` } }));
}

/** Starts only newly allocated resources; a bind conflict is a hard failure. */
export async function startCompleteFixture({ evidenceDir, port = 18763 }) {
  assert.ok(globalThis.Bun, 'invoke this fixture with Bun');
  await mkdir(evidenceDir, { recursive: true });
  const cleanup = { errors: [] };
  let directory, assets, transport, child, exited, url, stopped = false;
  let stdout = '', stderr = '';
  async function stop() {
    assert.equal(stopped, false); stopped = true;
    const clean = async (key, operation) => {
      try { cleanup[key] = await operation() ?? true; }
      catch (error) { cleanup.errors.push({ key, error: String(error) }); }
    };
    // Close both native WS hops before shutting down the Go reverse proxy.
    if (transport) await clean('transport', () => transport.stop());
    if (child) await clean('process', async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      let result;
      try { result = await bounded(exited, 'Go process exit', 8000); }
      catch (error) { child.kill('SIGKILL'); await exited; throw error; }
      assert.equal(result.code, 0, stderr); return { ...result, pid: child.pid, exited: true };
    });
    if (url) await clean('goPortReleased', () => confirmPortReleased(Number(new URL(url).port)));
    if (transport) {
      await clean('transportPortReleased', () => confirmPortReleased(Number(new URL(transport.url).port)));
      await clean('basePortReleased', () => confirmPortReleased(Number(new URL(transport.base.url).port)));
    }
    if (assets) await clean('assetsRemoved', () => rm(assets.directory, { recursive: true, force: true }));
    if (directory) await clean('ownedRootRemoved', () => rm(directory, { recursive: true, force: true }));
    await writeFile(join(evidenceDir, 'qa-fixture-stdout.log'), stdout);
    await writeFile(join(evidenceDir, 'qa-fixture-stderr.log'), stderr);
    await save(evidenceDir, 'qa-fixture-cleanup.json', cleanup);
    return cleanup;
  }
  try {
    directory = await mkdtemp(join(tmpdir(), 'dag-complete-'));
    const storeRoot = join(directory, 'store'); await mkdir(storeRoot);
    assets = await snapshotAssets(); await save(evidenceDir, 'qa-asset-hashes.json', assets);
    const binary = join(directory, 'fixture');
    const command = ['build', '-o', binary, 'test/qa/dag_complete_fixture.go'];
    await save(evidenceDir, 'qa-build-command.json', { cwd: root, executable: 'go', args: command });
    const built = await launchChild('go', command, { cwd: root }); assert.equal(built.code, 0, 'Go fixture build');
    transport = startTaskFixture({ assetsDir: assets.directory, layout: { kind: 'leaf', id: 'qa-pane', sessionId: 'qa-chat' },
      runs: { 'qa-chat': { entries: transcript() } } });
    child = spawn(binary, ['--root', storeRoot, '--listen', `127.0.0.1:${port}`, '--transport', transport.url], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    // Attach readiness/error/exit listeners before receiving the first output byte.
    const ready = new Promise((resolve, reject) => {
      const output = chunk => {
        stdout += chunk.toString();
        const match = /DAG_COMPLETE_READY (http:\/\/127\.0\.0\.1:\d+)\n/.exec(stdout);
        if (match) resolve(match[1]);
      };
      child.stdout.on('data', output); child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.once('error', reject);
      exited.then(result => reject(new Error(`Fixture exited before readiness: ${JSON.stringify(result)} ${stderr}`)));
    });
    url = await bounded(ready, 'Go fixture readiness', 30000);
    const manifest = JSON.parse(await readFile(join(storeRoot, 'manifest.json'), 'utf8'));
    await save(evidenceDir, 'qa-fixture-manifest.json', manifest);
    async function source(id) { return JSON.parse(await readFile(join(storeRoot, manifest.files[id]), 'utf8')); }
    async function replace(id, record) {
      const path = join(storeRoot, manifest.files[id]);
      await writeFile(path + '.qa-next', JSON.stringify(record), { mode: 0o600 });
      await rename(path + '.qa-next', path);
    }
    async function isolateEmptyCatalog() {
      const runsDir = join(storeRoot, 'workspace', '.omo', 'senpi-task', 'dag', 'runs');
      const aside = `${runsDir}.qa-aside`;
      await rename(runsDir, aside);
      await mkdir(runsDir, { recursive: true, mode: 0o700 });
      return async () => {
        await rm(runsDir, { recursive: true, force: true });
        await rename(aside, runsDir);
      };
    }
    return { url, manifest, storeRoot, source, replace, isolateEmptyCatalog,
      expected: async id => expectedRun(await source(id)), transport, stop };
  } catch (error) { await stop(); throw error; }
}
