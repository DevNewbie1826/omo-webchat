import { readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer as httpServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { createHash } from 'node:crypto';
const harness = dirname(fileURLToPath(import.meta.url));
const evidence = dirname(harness);
const root = resolve(evidence, '../../..');
const frontend = resolve(root, 'frontend');
const temporary = resolve(evidence, '.chat-switch-temp');
const { build } = await import(resolve(frontend, 'node_modules/vite/dist/node/index.js'));
const sourcePath = resolve(frontend, 'src/features/split/ChatTranscript.tsx');
const sourceHash = async () => createHash('sha256').update(await readFile(sourcePath)).digest('hex');
const results = { recordedAt: new Date().toISOString(), sourceSha256: await sourceHash(), viewport: { width: 390, height: 844 }, method: 'Built production ChatTranscript, same mounted component across 300 -> 4 -> 300 item replacements with restoreVersion increment. Real headless Google Chrome through CDP. Virtual-core estimate outputs and resizeItem inputs instrumented by build-only transform; no source/dependency files modified. Frame and DOM-mutation observations cover transitions; finite measurement cache and total checked at each step.', steps: [], pass: false };
let server, chrome, socket, chromeExit, browserContextId, browser;
const receipt = { serverPid: process.pid, serverClosed: false, chromePid: null, chromeExited: false, browserContextClosed: false, webSocketClosed: false, temporaryRemoved: false, portsFree: false };
const port = 5237;
const pending = new Map(); let sequence = 0;
const cdp = (method, params = {}, sessionId) => new Promise((resolveCall, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
  pending.set(id, { resolve: (value) => { clearTimeout(timer); resolveCall(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
  socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const evaluate = async (fn, ...args) => {
  const result = await cdp('Runtime.evaluate', { expression: `(${fn.toString()})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true }, browser);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const freePort = (value) => new Promise((yes, no) => { const probe = netServer(); probe.once('error', no); probe.listen(value, '127.0.0.1', () => probe.close(() => yes(true))); });
try {
  await freePort(port);
  try { await access(temporary); throw new Error('Temporary directory already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(temporary);
  const transformEvidence = {};
  await build({ configFile: false, root: harness, cacheDir: resolve(temporary, 'cache'), publicDir: false,
    resolve: { alias: { react: resolve(frontend, 'node_modules/react'), 'react-dom': resolve(frontend, 'node_modules/react-dom') } },
    esbuild: { jsx: 'automatic' },
    plugins: [{ name: 'qa-size-observer', enforce: 'pre', transform(code, id) {
      if (!id.includes('@tanstack/virtual-core/dist/esm/index.js')) return null;
      const estimates = [...code.matchAll(/this\.options\.estimateSize\((i|index)\)/g)];
      const resize = 'this.resizeItem = (index, size) => {';
      if (estimates.length !== 2 || !code.includes(resize)) throw new Error('Unexpected virtual-core instrumentation sites');
      transformEvidence.estimateSites = estimates.length; transformEvidence.resizeSites = 1;
      return code.replace(/this\.options\.estimateSize\((i|index)\)/g, 'window.__qaSize("estimate", $1, this.options.estimateSize($1), this)').replace(resize, `${resize}\nwindow.__qaSize("measurement", index, size, this);`);
    } }], build: { outDir: resolve(temporary, 'dist'), emptyOutDir: true, minify: false, sourcemap: false } });
  if (transformEvidence.estimateSites !== 2) throw new Error('Instrumentation not applied');
  results.instrumentation = transformEvidence;
  server = httpServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const file = resolve(temporary, 'dist', `.${path === '/' ? '/index.html' : path}`);
      if (!file.startsWith(resolve(temporary, 'dist') + '/')) { response.writeHead(403); response.end(); return; }
      response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
      response.end(await readFile(file));
    } catch (error) { response.writeHead(404); response.end(String(error)); }
  });
  await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); });
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-breakpad', '--disable-crash-reporter', '--remote-debugging-port=0', `--user-data-dir=${resolve(temporary, 'chrome-profile')}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  receipt.chromePid = chrome.pid;
  chromeExit = new Promise((yes) => chrome.once('exit', (code, signal) => yes({ code, signal })));
  const endpoint = await new Promise((yes, no) => {
    const timeout = setTimeout(() => no(new Error('Chrome endpoint timeout')), 30000);
    let text = '';
    chrome.stderr.on('data', (data) => { text += data; const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timeout); yes(match[1]); } });
    chrome.once('error', (error) => { clearTimeout(timeout); no(error); });
    chromeExit.then(() => { clearTimeout(timeout); no(new Error(`Chrome exited: ${text}`)); });
  });
  receipt.debugPort = Number(new URL(endpoint).port);
  socket = new WebSocket(endpoint);
  await new Promise((yes, no) => { socket.addEventListener('open', yes, { once: true }); socket.addEventListener('error', no, { once: true }); });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data); if (!message.id) return;
    const call = pending.get(message.id); if (!call) return; pending.delete(message.id);
    if (message.error) call.reject(new Error(JSON.stringify(message.error))); else call.resolve(message.result);
  });
  results.browser = await cdp('Browser.getVersion');
  ({ browserContextId } = await cdp('Target.createBrowserContext'));
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank', browserContextId });
  ({ sessionId: browser } = await cdp('Target.attachToTarget', { targetId, flatten: true }));
  await cdp('Page.enable', {}, browser);
  await cdp('Runtime.enable', {}, browser);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, browser);
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/` }, browser);
  // Readiness subscribes before a possible commit, then rechecks the current state.
  await evaluate(() => new Promise((yes, no) => {
    const timer = setTimeout(() => no(new Error('Chat ready timeout')), 30000);
    const ready = () => { if (!window.__chatReady) return; clearTimeout(timer); window.removeEventListener('chat-committed', ready); requestAnimationFrame(() => requestAnimationFrame(yes)); };
    window.addEventListener('chat-committed', ready); ready();
  }));
  await evaluate(() => {
    const a = window.__audit;
    window.__snapshot = (step) => {
      const el = document.querySelector('.th-chat-body');
      const v = a.instances.at(-1);
      const measurements = v.getMeasurements();
      const invalid = measurements.filter(row => !Number.isFinite(row.size) || !Number.isFinite(row.start) || !Number.isFinite(row.end));
      const bounds = el.getBoundingClientRect();
      const rows = [...el.querySelectorAll('[data-index]')];
      const total = v.getTotalSize();
      return { step, chat: document.documentElement.dataset.chat, renderedRowCount: rows.length, visibleRowCount: rows.filter(row => { const r = row.getBoundingClientRect(); return r.bottom > bounds.top && r.top < bounds.bottom; }).length, totalContentHeight: total, domHistoryHeight: el.querySelector('.th-chat-history').getBoundingClientRect().height, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, indices: rows.map(row => Number(row.dataset.index)), nonFiniteSizesSeen: a.nonFinite.length, invalidCachedSizes: invalid.length, sizeCalls: { ...a.calls }, virtualizerCount: v.options.count, virtualizerInstances: a.instances.length, pass: rows.length > 0 && a.nonFinite.length === 0 && invalid.length === 0 && Number.isFinite(total) && total > 0 };
    };
    a.observer = new MutationObserver(() => a.samples.push(window.__snapshot(a.phase + ':mutation')));
    a.observer.observe(document.querySelector('.th-chat-body'), { childList: true, subtree: true, attributes: true });
    a.monitor = true;
    const sampleFrame = () => { if (!a.monitor) return; a.samples.push(window.__snapshot(a.phase + ':frame')); requestAnimationFrame(sampleFrame); };
    requestAnimationFrame(sampleFrame);
  });
  results.steps.push(await evaluate(() => window.__snapshot('Long chat initially at bottom')));
  const wheel = async (deltaY) => {
    await evaluate(() => {
      window.__wheelDone = new Promise((yes, no) => {
        const timer = setTimeout(() => no(new Error('Wheel scrollend timeout')), 10000);
        document.querySelector('.th-chat-body').addEventListener('scrollend', () => { clearTimeout(timer); requestAnimationFrame(() => requestAnimationFrame(yes)); }, { once: true });
      });
    });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 195, y: 422, deltaX: 0, deltaY }, browser);
    await evaluate(() => window.__wheelDone);
  };
  await wheel(-500);
  results.unvisitedHistory = await evaluate(() => {
    const a = window.__audit; a.phase = 'long-history';
    const v = a.instances.at(-1); const targetIndex = 100;
    const target = v.getMeasurements()[targetIndex];
    return { targetIndex, previouslyMeasured: v.itemSizeCache.has(target.key), previouslyRendered: a.samples.some(sample => sample.indices.includes(targetIndex)), wheelDelta: target.start - document.querySelector('.th-chat-body').scrollTop };
  });
  await wheel(results.unvisitedHistory.wheelDelta);
  results.unvisitedHistory.targetMountedAfterScroll = await evaluate(() => !!document.querySelector('[data-index="100"]'));
  if (!results.unvisitedHistory.targetMountedAfterScroll) throw new Error('Wheel did not remain in never-visited history');
  results.steps.push(await evaluate(() => window.__snapshot('Long chat in never-visited history')));
  for (const [chat, step, screenshot] of [['short', 'Switched to short chat', 'chat-switch-short-390x844.png'], ['long', 'Switched back to long chat', 'chat-switch-back-390x844.png']]) {
    await evaluate((chat) => new Promise((yes, no) => {
      window.__audit.phase = `switch-${chat}`;
      const timer = setTimeout(() => no(new Error('Switch commit timeout')), 10000);
      window.addEventListener('chat-committed', () => { clearTimeout(timer); requestAnimationFrame(() => requestAnimationFrame(yes)); }, { once: true });
      window.__switchChat(chat);
    }), chat);
    results.steps.push(await evaluate((step) => window.__snapshot(step), step));
    const image = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, browser);
    await writeFile(resolve(evidence, screenshot), Buffer.from(image.data, 'base64'));
  }
  results.observations = await evaluate(() => { const a = window.__audit; a.monitor = false; a.observer.disconnect(); return { samples: a.samples, nonFinite: a.nonFinite, viewport: { width: innerWidth, height: innerHeight } }; });
  results.pass = results.steps.every(step => step.pass && step.visibleRowCount > 0) && results.observations.samples.every(sample => sample.pass && sample.visibleRowCount > 0) && !results.unvisitedHistory.previouslyMeasured && !results.unvisitedHistory.previouslyRendered && results.unvisitedHistory.targetMountedAfterScroll && results.observations.viewport.width === 390 && results.observations.viewport.height === 844;
} catch (error) {
  results.error = String(error.stack ?? error);
} finally {
  if (browserContextId && socket?.readyState === WebSocket.OPEN) { await cdp('Target.disposeBrowserContext', { browserContextId }); receipt.browserContextClosed = true; }
  if (socket) { const closed = new Promise(yes => socket.addEventListener('close', yes, { once: true })); socket.close(); await closed; receipt.webSocketClosed = true; }
  if (chrome) { chrome.kill('SIGTERM'); receipt.chromeExit = await chromeExit; receipt.chromeExited = true; }
  if (server) { await new Promise((yes, no) => server.close(error => error ? no(error) : yes())); receipt.serverClosed = true; }
  await rm(temporary, { recursive: true, force: true });
  try { await access(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; receipt.temporaryRemoved = true; }
  receipt.portsFree = await freePort(port) && (!receipt.debugPort || await freePort(receipt.debugPort));
  receipt.servePort = port;
  receipt.sourceUnchangedDuringRun = results.sourceSha256 === await sourceHash();
  results.cleanup = receipt;
  await writeFile(resolve(evidence, 'chat-switch.json'), JSON.stringify(results, null, 2) + '\n');
  const table = ['| Step | Rows rendered | Content height (px) | Non-finite sizes seen | Result |', '| --- | ---: | ---: | ---: | --- |', ...results.steps.map(step => `| ${step.step} | ${step.renderedRowCount} | ${step.totalContentHeight} | ${step.nonFiniteSizesSeen} | ${step.pass ? 'PASS' : 'FAIL'} |`)].join('\n');
  await writeFile(resolve(evidence, 'verdict.md'), `# Chat switching: ${results.pass ? 'PASS' : 'FAIL'}\n\n${table}\n\nReal Google Chrome at 390x844; production ChatTranscript built with Vite. A 300-row chat was scrolled directly into unmeasured history, replaced in-place with 4 rows, then restored to 300 rows. Screenshots are taken after the switch commit and browser layout frames, without fixed sleeps.\n\nBuild-only instrumentation observes every estimate output and resizeItem measurement input; cached geometry is checked at each DOM mutation/frame. ${results.observations?.samples.length ?? 0} transition observations; ${results.observations?.samples.filter(sample => !sample.pass || sample.visibleRowCount === 0).length ?? 'unknown'} blank/invalid observations. This demonstrates the fixture in Chrome, not a universal guarantee across browsers or backend chat loading.\n\nSource SHA-256: \`${results.sourceSha256}\`. No application source was edited. Fixture switches use distinct message IDs and increment restoreVersion on the same mounted component, matching ChatPane's transcript prop surface.\n\nCleanup: ${JSON.stringify(receipt)}\n${results.error ? `\nError: ${results.error}\n` : ''}`);
  await writeFile(resolve(evidence, 'chat-switch-cleanup.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(table); console.log('CLEANUP RECEIPT', JSON.stringify(receipt));
}
if (!results.pass) process.exitCode = 1;
