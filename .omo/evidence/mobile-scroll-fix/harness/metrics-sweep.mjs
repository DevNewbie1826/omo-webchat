import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, rm, access, readFile } from 'node:fs/promises';
const harness = dirname(fileURLToPath(import.meta.url));
const evidence = dirname(harness);
const root = resolve(evidence, '../../..');
const frontend = resolve(root, 'frontend');
const { createServer } = await import(resolve(frontend, 'node_modules/vite/dist/node/index.js'));
const output = resolve(evidence, 'after');
const cacheDir = resolve(evidence, 'metrics-vite-cache');
const results = { recordedAt: new Date().toISOString(), widths: [390, 600], fontSizes: [10, 13, 17, 24], rows: [], pass: false, method: 'Real ChatTranscript and useAppConfig in Bun.WebView. Unmeasured row 40 is read from the real virtualizer; an identical mounted row supplies browser height. Settings completion uses effect/layout signals, not delays. Intrinsic glyph advance independently measured with Range.', sampleEquality: { byteIdentical: false } };
const sampleSource = resolve(frontend, 'src/features/split/chatRowEstimate.ts');
const sampleSourceText = await readFile(sampleSource, 'utf8').catch((error) => {
  throw new Error(`Unable to read estimator sample from ${sampleSource}: ${error.message}`, { cause: error });
});
const sampleMatch = sampleSourceText.match(/const SAMPLE\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*;/s);
if (!sampleMatch) throw new Error(`Unable to find SAMPLE in estimator source: ${sampleSource}`);
const sampleLiteral = sampleMatch[1];
if (sampleLiteral[0] === "'" && /\\/.test(sampleLiteral.slice(1, -1))) {
  throw new Error('Unable to decode SAMPLE: single-quoted JavaScript escapes are rejected');
}
const SAMPLE = JSON.parse(sampleLiteral[0] === '"' ? sampleLiteral : JSON.stringify(sampleLiteral.slice(1, -1)));
const independentlyResolvedSample = Function(`return (${sampleLiteral})`)();
if (SAMPLE !== independentlyResolvedSample) {
  throw new Error('SAMPLE derivation mismatch: resolved values are not byte-identical');
}
results.sampleEquality = { byteIdentical: Buffer.byteLength(SAMPLE) === Buffer.byteLength(independentlyResolvedSample) && SAMPLE === independentlyResolvedSample, bytes: Buffer.byteLength(SAMPLE) };
let server;
let view;
const evaluate = (fn, ...args) => view.evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
try {
  server = await createServer({ configFile: false, root: frontend, cacheDir, resolve: { alias: { react: resolve(frontend, 'node_modules/react'), 'react-dom': resolve(frontend, 'node_modules/react-dom') } }, optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-dev-runtime', '@tanstack/react-virtual', 'react-markdown', 'remark-gfm', 'remark-math', 'rehype-katex'] }, esbuild: { jsx: 'automatic' }, server: { port: 5211, strictPort: true, fs: { allow: [root] } } });
  await server.listen();
  for (const width of results.widths) {
    view = new Bun.WebView({ width, height: 844 });
    await view.navigate(`http://localhost:5211/@fs${harness}/metrics-sweep.html`);
    await evaluate(() => new Promise((resolve, reject) => {
      if (window.__sweepConfig && document.querySelector('[data-index="299"]')) return resolve();
      const timeout = setTimeout(() => reject(new Error('Initial render timeout')), 30000);
      window.addEventListener('sweep-applied', () => { clearTimeout(timeout); resolve(); }, { once: true });
    }));
    for (const fontSize of results.fontSizes) {
      await evaluate((fontSize) => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Settings commit timeout')), 10000);
        window.addEventListener('sweep-applied', () => { clearTimeout(timeout); resolve(); }, { once: true });
        window.__sweepConfig.setFontSize(fontSize);
      }), fontSize);
      const row = await evaluate(async (fontSize, sample) => {
        const el = document.querySelector('.th-chat-body');
        const { readRowMetrics, estimateRowHeight } = await import('/src/features/split/chatRowEstimate.ts');
        const metrics = readRowMetrics(el);
        const mounted = el.querySelector('[data-index]');
        if (!mounted) throw new Error('No reference row mounted');
        let fiber = el[Object.keys(el).find(key => key.startsWith('__reactFiber$'))];
        let virtualizer;
        for (; fiber && !virtualizer; fiber = fiber.return) {
          for (let hook = fiber.memoizedState; hook; hook = hook.next) {
            const candidate = hook.memoizedState;
            for (const value of [candidate, candidate?.current, ...(Array.isArray(candidate) ? candidate : [])]) {
              if (value && typeof value.getMeasurements === 'function' && value.options?.count === 300) virtualizer = value;
            }
          }
        }
        if (!virtualizer) throw new Error('Real virtualizer not found in React hook state');
        const item = virtualizer.getMeasurements()[40];
        const measuredCacheContainsRow = virtualizer.itemSizeCache.has(item.key);
        const span = document.createElement('span');
        span.textContent = sample;
        span.style.whiteSpace = 'pre';
        mounted.querySelector('.th-chat-markdown').append(span);
        const range = document.createRange(); range.selectNodeContents(span);
        const intrinsicAdvance = range.getBoundingClientRect().width / span.textContent.length;
        span.remove();
        const text = mounted.querySelector('.th-chat-markdown').textContent;
        const freshEstimate = estimateRowHeight({ kind: 'message', message: { role: 'assistant', ts: 1, blocks: [{ kind: 'text', text }] } }, metrics);
        return { viewportWidth: innerWidth, scrollportWidth: el.clientWidth, fontSize, appliedFontSize: parseFloat(getComputedStyle(el).fontSize), metrics, intrinsicAdvance, glyphError: Math.abs(metrics.charWidth - intrinsicAdvance), unmeasuredRow: 40, measuredCacheContainsRow, estimate: item.size, freshEstimate, browserMeasuredRow: Number(mounted.dataset.index), browserHeight: mounted.getBoundingClientRect().height };
      }, fontSize, SAMPLE);
      row.pass = row.appliedFontSize === fontSize && row.glyphError <= 0.05 && !row.measuredCacheContainsRow && row.estimate === row.freshEstimate;
      results.rows.push(row);
    }
    view.close(); view = undefined;
  }
  results.tracking = results.widths.map(width => {
    const rows = results.rows.filter(row => row.viewportWidth === width);
    return { width, glyphsIncrease: rows.every((row, i) => !i || row.metrics.charWidth > rows[i - 1].metrics.charWidth), estimatesIncrease: rows.every((row, i) => !i || row.estimate > rows[i - 1].estimate) };
  });
  results.widthChangesEstimate = results.fontSizes.every(size => {
    const rows = results.rows.filter(row => row.fontSize === size);
    return rows[0].estimate > rows[1].estimate;
  });
  results.pass = results.rows.every(row => row.pass) && results.tracking.every(row => row.glyphsIncrease && row.estimatesIncrease) && results.widthChangesEstimate;
} catch (error) {
  results.error = String(error.stack ?? error);
  if (view) results.browserFailure = await evaluate(() => ({ text: document.body.innerText, errors: window.__errors, config: !!window.__sweepConfig }));
} finally {
  view?.close();
  await server?.close();
  await rm(cacheDir, { recursive: true, force: true });
  const cmp = Bun.spawn(['cmp', resolve(frontend, 'node_modules/@tanstack/virtual-core/dist/esm/index.js'), resolve(evidence, 'virtual-core-index.original.js')]);
  const cmpExitCode = await cmp.exited;
  const port = Bun.spawn(['lsof', '-i', ':5211'], { stdout: 'pipe', stderr: 'pipe' });
  const portOutput = await new Response(port.stdout).text(); await port.exited;
  let temporaryRemoved = false;
  try { await access(resolve(frontend, '.qa-harness')); } catch (error) { if (error.code !== 'ENOENT') throw error; temporaryRemoved = true; }
  results.cleanup = { viteStopped: true, temporaryRemoved, coreRestored: cmpExitCode === 0, cmpExitCode, portFree: !portOutput.trim(), sweepCacheRemoved: true };
  await writeFile(resolve(output, 'metrics-sweep.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
}
if (!results.pass) process.exitCode = 1;
