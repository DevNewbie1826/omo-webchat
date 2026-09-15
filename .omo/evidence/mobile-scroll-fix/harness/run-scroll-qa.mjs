import { copyFile, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const harness = dirname(fileURLToPath(import.meta.url));
const evidence = dirname(harness);
const root = resolve(evidence, '../../..');
const frontend = resolve(root, 'frontend');
const temporary = resolve(frontend, '.qa-harness');
const core = resolve(frontend, 'node_modules/@tanstack/virtual-core/dist/esm/index.js');
const backup = resolve(evidence, 'virtual-core-index.original.js');
const mode = process.argv[process.argv.indexOf('--mode') + 1];
if (!['baseline', 'after'].includes(mode)) throw new Error('Usage: bun run-scroll-qa.mjs --mode baseline|after');
const output = resolve(evidence, mode);
const cache = resolve(frontend, 'node_modules/.vite');
const receipt = { mode, viteStopped: false, temporaryRemoved: false, coreRestored: false, cmpExitCode: null, portFree: false };
let server;
let view;
let patched = false;
let temporaryCreated = false;
const save = (name, value) => writeFile(resolve(output, name), JSON.stringify(value, null, 2) + '\n');
const run = async (cmd) => {
  const process = Bun.spawn(cmd, { cwd: frontend, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  return { stdout, stderr, code };
};
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : 0;
};
const evaluate = (fn, ...args) => view.evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
async function stopServer() {
  if (!server) return;
  const pid = server.pid;
  try { process.kill(-pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  await server.exited;
  server = undefined;
  receipt.viteStopped = true;
}
async function startServer(force = false) {
  const log = Bun.file(resolve(output, force ? 'vite-ios.log' : 'vite.log')).writer();
  server = Bun.spawn(['npx', 'vite', '--port', '5211', '--strictPort', ...(force ? ['--force'] : [])], { cwd: frontend, detached: true, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } });
  await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error('Vite readiness timeout')), 30000);
    let all = '';
    const drain = async (stream) => {
      for await (const chunk of stream) {
        log.write(chunk);
        all += new TextDecoder().decode(chunk);
        if (all.includes('http://localhost:5211/')) { clearTimeout(timeout); resolveReady(); }
      }
    };
    Promise.all([drain(server.stdout), drain(server.stderr)]).then(() => log.end()).catch(reject);
    server.exited.then((code) => { clearTimeout(timeout); reject(new Error(`Vite exited ${code}: ${all}`)); });
  });
}
async function fresh() {
  await view.navigate(`http://localhost:5211/.qa-harness/index.html?run=${crypto.randomUUID()}`);
  await evaluate(() => new Promise((resolveReady, reject) => {
    if (window.__qaReady) return resolveReady(true);
    const timer = setTimeout(() => reject(new Error('Component readiness timeout')), 30000);
    window.addEventListener('qa-ready', () => { clearTimeout(timer); resolveReady(true); }, { once: true });
  }));
  const size = await evaluate(() => ({ width: innerWidth, height: innerHeight, scrollport: document.querySelector('.th-chat-body').clientHeight }));
  if (size.width !== 390 || size.height !== 844 || size.scrollport <= 0 || size.scrollport > 844) throw new Error(`Unbounded or wrong viewport: ${JSON.stringify(size)}`);
}
// These delays and interval samples are the requested time-based scroll experiment,
// not readiness polling. Component/server readiness uses exact events above.
async function position(hop, wait) {
  await evaluate(async (hop, wait) => {
    const el = document.querySelector('.th-chat-body');
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    el.scrollTop = el.scrollHeight;
    await delay(800);
    el.scrollTop -= hop;
    await delay(wait);
  }, hop, wait);
}
async function travel(distance, interval, duration, rows = false) {
  return evaluate(async (distance, interval, duration, rows) => {
    const el = document.querySelector('.th-chat-body');
    const start = el.scrollTop;
    const target = start - distance;
    if (target < 0) throw new Error(`Insufficient scroll range: ${start}`);
    const beginning = performance.now();
    const sample = () => ({ ms: performance.now() - beginning, scrollTop: el.scrollTop, ...(rows ? { rows: [...el.querySelectorAll('[data-index]')].map((row) => ({ index: Number(row.dataset.index), top: row.getBoundingClientRect().top })) } : {}) });
    const samples = [sample()];
    const completion = new Promise((resolve) => {
      const timer = setInterval(() => { samples.push(sample()); if (performance.now() - beginning >= duration) { clearInterval(timer); resolve(); } }, interval);
    });
    el.scrollTo({ top: target, behavior: 'smooth' });
    await completion;
    return { start, target, landed: el.scrollTop, shortfall: el.scrollTop - target, travelled: el.scrollTop - start, samples };
  }, distance, interval, duration, rows);
}
async function restoreCore() {
  if (!patched) return;
  await copyFile(backup, core);
  await rm(cache, { recursive: true, force: true });
  const comparison = await run(['cmp', core, backup]);
  receipt.cmpExitCode = comparison.code;
  if (comparison.code !== 0) throw new Error(`Core restoration failed: ${comparison.stderr}`);
  patched = false;
  receipt.coreRestored = true;
}

await mkdir(output, { recursive: true });
try {
  await access(core).catch(() => { throw new Error(`Dependencies missing: ${core}. Provision frontend dependencies before running; the harness does not install or alter dependency manifests.`); });
  const occupied = await run(['lsof', '-nP', '-i', ':5211']);
  if (occupied.stdout.trim()) throw new Error(`Port 5211 already occupied:\n${occupied.stdout}`);
  try { await access(temporary); throw new Error(`Refusing to overwrite existing ${temporary}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(temporary);
  temporaryCreated = true;
  await copyFile(resolve(harness, 'index.html'), resolve(temporary, 'index.html'));
  await copyFile(resolve(harness, 'main.tsx'), resolve(temporary, 'main.tsx'));
  const source = await readFile(resolve(frontend, 'src/features/split/ChatTranscript.tsx'), 'utf8');
  await save('metadata.json', { mode, recordedAt: new Date().toISOString(), viewport: { width: 390, height: 844 }, bun: Bun.version, sourceSha256: new Bun.CryptoHasher('sha256').update(source).digest('hex'), constantEstimate80Present: /estimateSize:\s*\(\)\s*=>\s*80/.test(source), fixture: '300 rows; assistant ordinal controls paragraph/list/code/image cadence; unloaded image is a text placeholder' });
  if (mode === 'baseline' && !/estimateSize:\s*\(\)\s*=>\s*80/.test(source)) throw new Error('Baseline requires the original constant 80px estimator');
  await startServer();
  view = new Bun.WebView({ width: 390, height: 844 });
  await fresh();
  await save('browser.json', await evaluate(() => ({ userAgent: navigator.userAgent, width: innerWidth, height: innerHeight })));
  if (mode === 'after') await Bun.write(resolve(output, 'transcript-390x844.png'), await view.screenshot());
  await position(12000, 1400);
  if (mode === 'after') await Bun.write(resolve(output, 'transcript-older-history-390x844.png'), await view.screenshot());
  const m1 = await travel(4000, 25, 1500);
  await save('scroll-travel.json', m1);
  console.log('M1', m1.shortfall);

  await fresh();
  await position(6000, 1000);
  const m3 = await evaluate(async () => {
    const el = document.querySelector('.th-chat-body');
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const state = () => ({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, distanceFromBottom: el.scrollHeight - el.clientHeight - el.scrollTop, buttonPresent: !!document.querySelector('.th-chat-scroll-bottom') });
    const beforeAppend = state();
    window.__append();
    await delay(600);
    const afterAppendAway = state();
    el.scrollTop = el.scrollHeight;
    await delay(800);
    window.__append();
    await delay(800);
    return { beforeAppend, afterAppendAway, afterAppendBottom: state() };
  });
  await save('follow-intent.json', m3);

  await fresh();
  // Walk in frame-synchronised steps until an unloaded image-bearing row is
  // mounted wholly above the viewport and the first visible row is distinct.
  const m4 = await evaluate(async () => {
    const el = document.querySelector('.th-chat-body');
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    el.scrollTop = el.scrollHeight;
    await frame();
    let anchor;
    let imageIndex;
    for (let step = 0; step < 2000; step++) {
      const bounds = el.getBoundingClientRect();
      const rows = [...el.querySelectorAll('[data-index]')];
      const image = rows.find((row) => window.__qaRows[Number(row.dataset.index)]?.image && row.getBoundingClientRect().bottom <= bounds.top);
      anchor = rows.find((row) => row.getBoundingClientRect().bottom > bounds.top && row.getBoundingClientRect().top < bounds.bottom);
      if (image && anchor) { imageIndex = Number(image.dataset.index); break; }
      if (el.scrollTop <= 0) throw new Error('No mounted image row above viewport');
      el.scrollTop -= 250;
      await frame();
    }
    if (imageIndex === undefined || !anchor) throw new Error('Image anchor search exhausted');
    const index = Number(anchor.dataset.index);
    const before = anchor.getBoundingClientRect().top;
    const startScrollTop = el.scrollTop;
    window.__loadImages();
    await new Promise((resolve) => setTimeout(resolve, 800));
    const same = el.querySelector(`[data-index="${index}"]`);
    if (!same) throw new Error(`Image anchor ${index} unmounted`);
    const after = same.getBoundingClientRect().top;
    const imageRow = el.querySelector(`[data-index="${imageIndex}"]`);
    const img = imageRow?.querySelector('img');
    // The transcript renders result images with loading="lazy", so an image
    // row sitting wholly above the viewport is NOT decoded by the browser
    // until it approaches the fold. Both halves of the late-growth hazard are
    // therefore recorded rather than asserted: the block swap itself (text
    // placeholder -> <img> element) changes the row height immediately, and
    // the bitmap decode changes it again whenever the browser schedules it.
    // C4 is decided by `shift` — whether the content the reader is looking at
    // moved — not by whether the off-screen bitmap happened to decode.
    return {
      index, imageIndex, before, after, shift: after - before,
      startScrollTop, landedScrollTop: el.scrollTop,
      imageRowMounted: !!imageRow,
      imageElementPresent: !!img,
      imageComplete: img?.complete ?? false,
      imageNaturalWidth: img?.naturalWidth ?? 0,
      imageRowHeight: imageRow?.getBoundingClientRect().height ?? null,
    };
  });
  await save('image-shift.json', m4);

  await fresh();
  const measured = await evaluate(async (mode) => {
    const el = document.querySelector('.th-chat-body');
    const estimator = mode === 'after' ? await import('/src/features/split/chatRowEstimate.ts') : null;
    const fixture = mode === 'after' ? await import('/.qa-harness/main.tsx') : null;
    const metrics = estimator?.readRowMetrics(el);
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // M5 measures the fully populated fixture, including actual image blocks.
    window.__loadImages();
    await frame();
    el.scrollTop = el.scrollHeight;
    await frame();
    const found = new Map();
    for (let step = 0; step < 5000; step++) {
      for (const row of el.querySelectorAll('[data-index]')) {
        const index = Number(row.dataset.index);
        const image = row.querySelector('img');
        if (image && !image.complete) await new Promise((resolve, reject) => { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', reject, { once: true }); });
        const meta = window.__qaRows[index];
        const height = row.getBoundingClientRect().height;
        const estimate = estimator ? estimator.estimateRowHeight(fixture.makeRow(index, true), metrics) : 80;
        found.set(index, { index, role: meta.role, textLength: meta.textLength, height, estimate, absoluteError: Math.abs(height - estimate), absolutePercentError: Math.abs(height - estimate) / height * 100, ...(estimator ? { metrics } : {}) });
      }
      if (el.scrollTop <= 0) break;
      el.scrollTop = Math.max(0, el.scrollTop - 250);
      await frame();
    }
    return [...found.values()].sort((a, b) => a.index - b.index);
  }, mode);
  if (measured.length !== 300) throw new Error(`M5 measured ${measured.length}/300 rows`);
  const errors = measured.map((row) => row.absoluteError).sort((a, b) => a - b);
  const percentages = measured.map((row) => row.absolutePercentError).sort((a, b) => a - b);
  const m5 = { estimate: mode === 'after' ? 'estimateRowHeight(item, readRowMetrics(scrollElement))' : 80, interpretation: 'Absolute error in CSS px; percentage error is absolute error divided by measured height times 100. Median averages the middle pair; p90 uses nearest rank.', count: measured.length, medianError: median(errors), p90Error: errors[Math.ceil(errors.length * 0.9) - 1], maxError: errors.at(-1), medianAbsolutePercentError: median(percentages), p90AbsolutePercentError: percentages[Math.ceil(percentages.length * 0.9) - 1], maxAbsolutePercentError: percentages.at(-1), underestimatedRows: measured.filter((row) => row.height > row.estimate).length, rows: measured };
  await save('estimator-accuracy.json', m5);

  view.close(); view = undefined;
  await stopServer();
  await copyFile(core, backup);
  const original = await readFile(core, 'utf8');
  // Different virtual-core releases spell this function as an arrow or a declaration.
  const pattern = /(?:const isIOSWebKit\s*=\s*\([^)]*\)\s*=>|function isIOSWebKit\s*\([^)]*\))\s*\{/g;
  const matches = [...original.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`Expected one isIOSWebKit function, found ${matches.length}`);
  patched = true;
  await writeFile(core, original.replace(pattern, '$&\n  return true; // QA forced iOS path; restored in finally.'));
  await rm(cache, { recursive: true, force: true });
  await startServer(true);
  view = new Bun.WebView({ width: 390, height: 844 });
  const m2 = [];
  for (const hop of [8000, 16000, 24000]) {
    await fresh();
    await position(hop, 1000);
    const result = await travel(3000, 40, 2000, true);
    result.samples.forEach((sample, i, samples) => {
      if (!i) { sample.residual = 0; sample.sharedRows = 0; return; }
      const previous = samples[i - 1];
      const old = new Map(previous.rows.map((row) => [row.index, row.top]));
      const delta = sample.scrollTop - previous.scrollTop;
      const residuals = sample.rows.filter((row) => old.has(row.index)).map((row) => row.top - (old.get(row.index) - delta));
      sample.residual = residuals.length ? median(residuals) : null;
      sample.sharedRows = residuals.length;
    });
    const jumps = result.samples.filter((sample) => sample.residual !== null && Math.abs(sample.residual) > 1);
    m2.push({ hop, ...result, jumpFrames: jumps.length, maxJump: Math.max(0, ...jumps.map((sample) => Math.abs(sample.residual))), sumJump: jumps.reduce((sum, sample) => sum + Math.abs(sample.residual), 0), signedSumJump: jumps.reduce((sum, sample) => sum + sample.residual, 0) });
  }
  await save('ios-path.json', m2);
  view.close(); view = undefined;
  await stopServer();
  await restoreCore();
  await writeFile(resolve(output, 'README.md'), `# ${mode} mobile scroll measurements\n\nReal ChatTranscript; Bun.WebView 390x844. All distances are CSS pixels. Positive travelled means downward despite an upward request. Error compares measured height with the real content estimator in after mode and constant 80 in baseline mode. M2 sumJump is the sum of absolute residuals above 1px; signed total is also retained. Exact sample traces and all 300 row heights are in JSON.\n\n| Measurement | Values |\n|---|---|\n| M1 travel | start ${m1.start}; target ${m1.target}; landed ${m1.landed}; shortfall ${m1.shortfall}; ${m1.samples.length} samples |\n${m2.map((r) => `| M2 hop ${r.hop} | start ${r.start}; target ${r.target}; landed ${r.landed}; travelled ${r.travelled}; shortfall ${r.shortfall}; jumpFrames ${r.jumpFrames}; maxJump ${r.maxJump}; sumJump ${r.sumJump}; signedSumJump ${r.signedSumJump}; ${r.samples.length} samples |`).join('\n')}\n| M3 follow | before append distance ${m3.beforeAppend.distanceFromBottom}, button ${m3.beforeAppend.buttonPresent}; away append distance ${m3.afterAppendAway.distanceFromBottom}, button ${m3.afterAppendAway.buttonPresent}; bottom append distance ${m3.afterAppendBottom.distanceFromBottom}, button ${m3.afterAppendBottom.buttonPresent} |\n| M4 image | image row ${m4.imageIndex}; anchor ${m4.index}; before ${m4.before}; after ${m4.after}; shift ${m4.shift}; scrollTop ${m4.startScrollTop} → ${m4.landedScrollTop}; image width ${m4.imageNaturalWidth} |\n| M5 estimator | rows ${m5.count}; median error ${m5.medianError}; p90 error ${m5.p90Error}; max error ${m5.maxError}; underestimated ${m5.underestimatedRows} |\n\nSynthetic content is English fixture data. Cadence is counted over assistant messages, giving 1-4 paragraphs and images at indices 41,83,125,167,209,251,293. M1-M3 start with image placeholders; M4 swaps them; M5 measures loaded images. M2 forces the iOS library branch in desktop WebKit, not physical iOS gesture hardware.\n`);
  console.log(JSON.stringify({ M1: m1.shortfall, M2: m2.map(({ hop, travelled, maxJump }) => ({ hop, travelled, maxJump })), M3: m3, M4: m4.shift, M5: { median: m5.medianError, p90: m5.p90Error } }, null, 2));
} finally {
  if (view) view.close();
  try { await stopServer(); } finally {
    try { await restoreCore(); } finally {
      if (temporaryCreated) {
        await rm(temporary, { recursive: true, force: true });
        receipt.temporaryRemoved = true;
      }
      const port = await run(['lsof', '-nP', '-i', ':5211']);
      receipt.portFree = !port.stdout.trim();
      await save('cleanup.json', receipt);
      console.log('Cleanup receipt:', JSON.stringify(receipt));
      if (!receipt.portFree) throw new Error(`Port 5211 still in use: ${port.stdout}`);
    }
  }
}
