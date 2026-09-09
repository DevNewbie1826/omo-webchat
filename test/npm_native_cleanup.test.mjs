import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { bounded } from './npm_native_smoke.mjs';

for (const mode of ['normal', 'signal', 'win32-input']) {
  test(`worker joins actual Bun ${mode} completion and closes its listener`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native cleanup '));
    let worker;
    try {
      const assets = ['index.html', 'app.js', 'app.css'].map((name) => ({
        path: name, size: Buffer.byteLength(name), sha256: createHash('sha256').update(name).digest('hex'),
      }));
      // This tiny real HTTP child exercises only the worker's completion seam;
      // packaged cmd/server coverage remains in npm_native_smoke.test.mjs.
      const source = `
        const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch(request) {
          const route = new URL(request.url).pathname;
          if (route === '/api/login') return new Response('{}', {headers: {'set-cookie': 'th_session=fixture'}});
          if (route === '/api/auth/check') return new Response(JSON.stringify({status: 'ok'}), {status: request.headers.has('cookie') ? 200 : 401});
          return new Response(route === '/' ? 'index.html' : route.slice(1));
        }});
        ${mode === 'normal' ? "process.on('SIGINT', () => { server.stop(true); process.exit(0); });" : ''}
        ${mode === 'win32-input' ? `
          process.stdin.setRawMode(true);
          let input = '';
          process.stdin.on('data', chunk => {
            input += chunk.toString();
            if (input.includes('\\x1b[67;46;3;1;8;1_')) { server.stop(true); process.exit(0); }
            else if (input.includes('\\x03')) process.exit(42);
          });
          process.stdout.write('\\x1b[?9001h\\n');
        ` : ''}
        console.log('msg=listening addr=127.0.0.1:' + server.port);
      `;
      const config = path.join(root, 'worker.json');
      await writeFile(config, JSON.stringify({ root, variant: mode, command: [process.execPath, '-e', source], assets }));
      worker = Bun.spawn([process.execPath, path.resolve('test/npm_native_smoke.mjs'), '--worker', config], {
        cwd: root, env: { PATH: process.env.PATH, TH_PASSWORD: 'fixture' }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      });
      const output = new Response(worker.stdout).text();
      const errors = new Response(worker.stderr).text();
      const code = await bounded(worker.exited, 'regression worker completion', 30_000);
      const receipt = JSON.parse(await output);
      console.log(JSON.stringify({ mode, workerPID: worker.pid, workerExit: code, receipt, stderr: await errors }));
      assert.equal(code, 0, receipt.error);
      assert.equal(receipt.ok, true, receipt.error);
      assert.equal(receipt.exitCode, mode === 'signal' ? 130 : 0);
      assert.equal(receipt.cleanup.leaderJoined, true);
      assert.equal(receipt.cleanup.listenerClosed, true);
      assert.notEqual(receipt.cleanup.forced, true);
      assert.throws(() => process.kill(receipt.pid, 0), (error) => error.code === 'ESRCH');
      if (process.platform !== 'win32') {
        assert.equal(receipt.cleanup.processGroupGone, true);
        assert.throws(() => process.kill(-receipt.pid, 0), (error) => error.code === 'ESRCH');
      }
      await bounded(new Promise((resolve, reject) => {
        const [host, port] = receipt.address.split(':');
        const socket = net.connect({ host, port: Number(port) });
        socket.once('connect', () => { socket.destroy(); reject(new Error('listener still accepts')); });
        socket.once('error', (error) => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
      }), 'regression listener refusal', 5000);
    } finally {
      if (worker) {
        worker.stdin.end();
        await bounded(worker.exited, 'regression worker cleanup', 30_000);
        assert.throws(() => process.kill(worker.pid, 0), (error) => error.code === 'ESRCH');
      }
      await rm(root, { recursive: true, force: true });
      await assert.rejects(access(root), { code: 'ENOENT' });
      console.log(JSON.stringify({ mode, root, rootRemoved: true, workerJoined: Boolean(worker) }));
    }
  }, 90_000);
}
