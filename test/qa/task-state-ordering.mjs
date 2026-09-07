/** Actual built App, Chrome and native HTTP/WS task-ordering QA.
 * Node delegates this entry point to Bun. The verifier owns the fresh build;
 * this runner only snapshots its assets and owns disposable test resources.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { observeSockets } from './heartbeat-liveness.mjs';
import { confirmPortReleased, dagRow, installDOMSignals, launchChild, snapshotAssets } from './dag-state-ordering.mjs';
import { activityPath, chat, createTaskRequestGate, deadline, pollPath, startTaskFixture } from './task-state-fixture.mjs';

const script = fileURLToPath(import.meta.url), root = resolve(dirname(script), '../..');
const save = (dir, name, body) => writeFile(join(dir, name), JSON.stringify(body, null, 2) + '\n');
export const scenarios = ['raw-stale', 'heartbeat-completion', 'derived-revival', 'rest-first', 'ws-first', 'digest-alias', 'reconnect-clear'];
export function parseArgs(args) {
  assert.equal(args.length, 2, 'Usage: node test/qa/task-state-ordering.mjs --evidence-dir ABSOLUTE_PATH');
  assert.equal(args[0], '--evidence-dir'); assert.ok(args[1] && !args[1].startsWith('--'));
  return { evidenceDir: resolve(args[1]) };
}
export const stamp = minute => `2026-09-07T10:${String(minute).padStart(2, '0')}:00.000Z`;
export function taskRow(status, minute, extra = {}) {
  return { task_id: 'child-1', name: '검증 작업 - 完了した結果と新しい再試行を区別する long subagent identity',
    status, created_at: stamp(0), updated_at: stamp(minute), ...extra };
}
export function taskSnapshot(rows, owner = chat) { return { parent_session_id: owner, truncated_tasks: false, tasks: rows }; }
export function overviewFrame(rows, extra = {}) {
  const { sessionId = chat, durableSessionId = sessionId } = extra;
  return { type: 'sessions.activity', sessionId, durableSessionId,
    snapshots: [{ name: 'omo.task.updated', data: taskSnapshot(rows, durableSessionId), oversized: false }], overflow: false, ...extra };
}
const taskFrame = rows => ({ type: 'extensionEvent', name: 'omo.task.updated', data: taskSnapshot(rows) });
function dagFrame(status, minute) {
  const row = dagRow(status, String(minute).padStart(2, '0'));
  row.nodes[0].task_id = 'child-1';
  return { type: 'extensionEvent', name: 'omo.dag.updated', data: { parent_session_id: chat, runs: [row], truncated_runs: false } };
}
export function transcript() {
  return Array.from({ length: 160 }, (_, index) => ({ id: `ordering-entry-${index}`, parentId: index ? `ordering-entry-${index - 1}` : null,
    type: 'message', message: { role: index % 2 ? 'assistant' : 'user', content:
      `ordering-entry-${index}\n\n${'저장된 대화와 완료된 작업 상태를 확인합니다。新しい再試行。Long saved transcript. '.repeat(14)}\n\n- 검증 결과\n  - 중첩된 기록\n\n> 完了した作業\n\n\`\`\`js\nconst turn = ${index};\n\`\`\`` } }));
}
export const armDOM = (page, predicate, args) => page.evaluate(({ source, args }) => window.__dagQA.arm(source, args), { source: String(predicate), args });
export const doneDOM = (page, token) => page.evaluate(token => window.__dagQA.done(token), token);

/** A DOM read only: no state hooks, no injected styles, no alternative reducer. */
export function readTaskDOM() {
  const sidebarRow = name => [...document.querySelectorAll('.th-tree-node')].find(node =>
    node.querySelector('.th-tree-activation .th-tree-label')?.textContent === name);
  const row = sidebarRow('Stored A'), badge = row?.querySelector('.th-tree-running');
  return { agentsSelected: document.querySelector('[data-activity-tab="agents"]')?.getAttribute('aria-selected') === 'true',
    count: document.querySelector('[data-activity-tab="agents"] .th-activity-tab-count')?.textContent ?? null,
    agents: [...document.querySelectorAll('[data-activity-tabpanel="agents"] .th-activity-agent')].map(node => ({
      name: node.querySelector('.th-activity-agent-name')?.textContent,
      kind: node.querySelector('.th-activity-chip')?.className,
      tool: node.querySelector('.th-activity-agent-tool')?.textContent ?? null,
      line: node.querySelector('.th-activity-agent-lastline')?.textContent ?? null,
    })),
    sidebarPresent: !!row, sidebarRunning: badge ? Number.parseInt(badge.textContent, 10) : 0,
    sidebarBadge: badge?.textContent ?? null, sidebarLabel: badge?.getAttribute('aria-label') ?? null,
    sidebarVisible: document.querySelector('.th-sidebar')?.getAttribute('aria-hidden') !== 'true',
  };
}
export function assertTaskDOM(dom, status, { tool, total = 2 } = {}) {
  assert.ok(dom.agentsSelected && dom.sidebarPresent, 'agents tab and real stored sidebar row mounted');
  const target = dom.agents.filter(row => row.name === taskRow('running', 1).name);
  assert.equal(target.length, status === 'absent' ? 0 : 1, 'exact target membership');
  if (status !== 'absent') assert.ok(target[0].kind.split(' ').includes(`th-activity-chip--${status === 'running' ? 'running' : 'ok'}`), `target status ${status}`);
  if (tool !== undefined) assert.equal(target[0].tool, tool, 'newer activity survives intermediate raw completion');
  const running = status === 'running' ? 1 : 0;
  assert.equal(dom.count, `${running}/${total}`, 'agents-tab running/total count');
  assert.equal(dom.agents.length, total, 'rendered total agrees with tab');
  assert.equal(dom.sidebarRunning, running, 'sidebar running count agrees with agents tab');
  assert.equal(dom.agents.filter(row => row.kind.split(' ').includes('th-activity-chip--ok')).length,
    status === 'completed' ? 1 : 0, 'completed rows agree with expected outcome');
}

/** Caller-owned browser is retained; every invocation owns its contexts. */
export async function run({ evidenceDir, browser: suppliedBrowser, chromium, headless = true } = {}) {
  assert.ok(evidenceDir, 'evidenceDir is required'); evidenceDir = resolve(evidenceDir);
  await mkdir(evidenceDir, { recursive: true });
  if (!globalThis.Bun) {
    assert.ok(!suppliedBrowser && !chromium && headless, 'Injected/headed browser requires Bun run()');
    const child = await launchChild('/opt/homebrew/bin/bun', [script, '--evidence-dir', evidenceDir], { cwd: root });
    let cleanup;
    try { cleanup = JSON.parse(await readFile(join(evidenceDir, 'cleanup.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; cleanup = { errors: ['No Bun cleanup receipt'] }; }
    cleanup.child = child; await save(evidenceDir, 'cleanup.json', cleanup);
    assert.equal(child.code, 0, `Bun child exited ${child.code ?? child.signal}`);
    return { ...JSON.parse(await readFile(join(evidenceDir, 'browser-actions.json'), 'utf8')), cleanup };
  }
  const report = { cwd: root, startedAt: new Date().toISOString(), passed: false, actions: [], captures: [], errors: [], scenarios: [] };
  const cleanup = { browserOwned: !suppliedBrowser, cases: [], errors: [] };
  let browser, assets, failure;
  const record = row => report.actions.push({ sequence: report.actions.length + 1, ...row });
  try {
    assets = await snapshotAssets(join(root, 'frontend/dist'));
    await save(evidenceDir, 'asset-hashes.json', assets);
    const driver = chromium ?? (suppliedBrowser ? null : (await import(pathToFileURL(process.env.QA_PLAYWRIGHT ?? '/private/tmp/omo-asar/node_modules/playwright-core/index.mjs').href)).chromium);
    browser = suppliedBrowser ?? await driver.launch({ executablePath: process.env.QA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless, timeout: deadline });
    report.browserVersion = browser.version();
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      for (const scenario of scenarios) {
        const name = `${scenario}-${viewport.width}x${viewport.height}`;
        const result = { name, passed: false }, receipt = { name, errors: [] };
        report.scenarios.push(result); cleanup.cases.push(receipt);
        let context, page, fixture, observed, gate;
        let markerCount = 0, markerSequence = 0;
        const prefix = randomUUID();
        let restMarker = { task_id: 'qa-rest-marker', name: `rest-${prefix}-0`, status: 'pending', updated_at: stamp(30) };
        const rows = row => [...(row ? [row] : []), restMarker];
        const sidebarMarker = () => {
          markerCount++;
          return { id: 'newer', title: 'Newer', task: taskSnapshot(Array.from({ length: markerCount }, (_, i) => ({
            task_id: `marker-${prefix}-${i}`, name: `marker-${prefix}-${i}`, status: 'running',
          })), 'newer'), dag: null };
        };
        async function armSidebarMarker() {
          return armDOM(page, count => [...document.querySelectorAll('.th-tree-node')].some(node =>
            node.querySelector('.th-tree-activation .th-tree-label')?.textContent === 'Newer'
            && node.querySelector('.th-tree-running')?.textContent === String(count)), markerCount);
        }
        async function poll(token, row, label, extra = {}) {
          const marker = sidebarMarker(), signal = await armSidebarMarker();
          const body = { sessions: [{ id: chat, title: 'Stored A', task: taskSnapshot(rows(row)), dag: null, ...extra }, marker] };
          await gate.release(token, body); await doneDOM(page, signal);
          record({ case: name, action: label, token, body, markerCount, processed: true });
        }
        async function overview(frames, label) {
          const marker = sidebarMarker(), signal = await armSidebarMarker(), after = observed.mark();
          const sentinel = overviewFrame(marker.task.tasks, { sessionId: 'newer', durableSessionId: 'newer' });
          const delivered = observed.wait(row => row.direction === 'received' && JSON.stringify(row.frame) === JSON.stringify(sentinel), { after, label });
          for (const frame of frames) fixture.overview(frame);
          fixture.overview(sentinel);
          const received = await delivered; await doneDOM(page, signal);
          for (const frame of frames) assert.ok(observed.timeline.some(row => row.sequence > after && row.sequence < received.sequence
            && row.socketId === received.socketId && row.direction === 'received' && JSON.stringify(row.frame) === JSON.stringify(frame)), 'overview frame precedes positive DOM marker on same native socket');
          record({ case: name, action: label, frames, sentinel, socketId: received.socketId, processed: true });
        }
        async function attached(frames, label) {
          const sentinel = `task-canonical-${prefix}-${++markerSequence}`, after = observed.mark();
          const signal = await armDOM(page, text => document.querySelector('.th-chat-body')?.textContent.includes(text), sentinel);
          const delivered = observed.wait(row => row.direction === 'received' && row.frame?.type === 'message'
            && row.frame.message?.content === sentinel, { after, label });
          for (const frame of frames) fixture.deliver(chat, frame);
          fixture.deliver(chat, { type: 'message', message: { role: 'assistant', content: sentinel } });
          const received = await delivered; await doneDOM(page, signal);
          for (const frame of frames) assert.ok(observed.timeline.some(row => row.sequence > after && row.sequence < received.sequence
            && row.socketId === received.socketId && row.direction === 'received'
            && JSON.stringify(row.frame) === JSON.stringify({ ...frame, sessionId: chat })), 'attached frame precedes canonical DOM marker on same native socket');
          record({ case: name, action: label, frames, sentinel, socketId: received.socketId, processed: true });
        }
        async function openAgents() {
          if (await page.locator('[data-activity-tab="agents"]').getAttribute('aria-selected') === 'true'
            && await page.locator('.th-activity-fold').getAttribute('aria-expanded') === 'true') return;
          const signal = await armDOM(page, () => document.querySelector('[data-activity-tab="agents"]')?.getAttribute('aria-selected') === 'true'
            && document.querySelector('.th-activity-fold')?.getAttribute('aria-expanded') === 'true'
            && document.querySelector('[data-activity-tabpanel="agents"]')?.getBoundingClientRect().height > 0);
          await page.locator('[data-activity-tab="agents"]').click(); await doneDOM(page, signal);
        }
        async function hydrate(token, row, label) {
          const signal = await armDOM(page, marker => [...document.querySelectorAll('.th-activity-agent-name')].some(node => node.textContent === marker), restMarker.name);
          const body = { history: { task: taskSnapshot(rows(row)), dag: null } };
          await gate.release(token, body);
          const mounted = await armDOM(page, () => !!document.querySelector('[data-activity-tab="agents"]'));
          await doneDOM(page, mounted); await openAgents(); await doneDOM(page, signal);
          record({ case: name, action: label, token, body, marker: restMarker.name, processed: true });
        }
        async function check(status, options) {
          const dom = await page.evaluate(readTaskDOM); assertTaskDOM(dom, status, options);
          record({ case: name, action: 'assert-agents-sidebar-agreement', status, dom });
        }
        async function push(row, label, expected) {
          await overview([overviewFrame(rows(row))], label + '-overview');
          const sidebar = await page.evaluate(readTaskDOM);
          assert.equal(sidebar.sidebarRunning, expected === 'running' ? 1 : 0, 'overview source accepted before attached publication');
          await attached([taskFrame(rows(row))], label + '-attached'); await check(expected);
        }
        async function capture(suffix, { drawer = false } = {}) {
          // Exact font and finite animation completion, then a real paint opportunity.
          const settled = await page.evaluate(async limit => {
            let timer;
            try { return await Promise.race([(async () => {
              await document.fonts.ready;
              const finite = document.getAnimations().filter(a => Number.isFinite(a.effect.getComputedTiming().endTime) && !['finished', 'idle'].includes(a.playState));
              await Promise.all(finite.map(a => a.finished));
              const frames = [await new Promise(requestAnimationFrame), await new Promise(requestAnimationFrame)];
              const rect = selector => { const node = document.querySelector(selector); if (!node) return null;
                const box = node.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
                return { ...box.toJSON(), visible: node.checkVisibility({ visibilityProperty: true }), hit: !!hit && node.contains(hit) }; };
              const body = document.querySelector('.th-chat-body');
              return { frames, fonts: document.fonts.status, viewport: { width: innerWidth, height: innerHeight },
                documentWidth: document.documentElement.scrollWidth, panel: rect('.th-activity-panel'),
                tab: rect('[data-activity-tab="agents"]'), composer: rect('.th-chat-input textarea'), sidebar: rect('.th-sidebar'),
                transcript: body && { top: body.scrollTop, height: body.scrollHeight, client: body.clientHeight } };
            })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Capture settlement deadline')), limit); })]);
            } finally { clearTimeout(timer); }
          }, deadline);
          assert.ok(settled.transcript.height > settled.transcript.client, 'real long transcript overflows');
          assert.ok(settled.documentWidth <= viewport.width, 'no document horizontal overflow');
          if (!drawer) for (const box of [settled.panel, settled.tab, settled.composer]) assert.ok(box?.visible && box.width > 0
            && box.height > 0 && box.x >= 0 && box.y >= 0 && box.right <= viewport.width + 1 && box.bottom <= viewport.height + 1, 'bounded task shelf and composer');
          if (!drawer) assert.ok(settled.composer.hit, 'composer unobscured');
          const filename = `${name}-${suffix}`, png = await page.screenshot({ path: join(evidenceDir, filename + '.png'), fullPage: false });
          assert.equal(png.readUInt32BE(16), viewport.width); assert.equal(png.readUInt32BE(20), viewport.height);
          const data = { name: filename, ...settled, dom: await page.evaluate(readTaskDOM),
            screenshot: { bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') } };
          await writeFile(join(evidenceDir, filename + '.html'), await page.content());
          await save(evidenceDir, filename + '.json', data); report.captures.push(data);
        }
        try {
          fixture = startTaskFixture({ assetsDir: assets.directory, layout: 'single', runs: { [chat]: { entries: transcript() } } });
          receipt.fixtureURL = fixture.url; receipt.baseURL = fixture.base.url;
          context = await browser.newContext({ viewport, reducedMotion: 'reduce' }); context.setDefaultTimeout(deadline);
          page = await context.newPage(); observed = observeSockets(page);
          page.on('pageerror', error => report.errors.push({ case: name, kind: 'pageerror', error: String(error) }));
          page.on('console', message => { if (message.type() === 'error') report.errors.push({ case: name, kind: 'console', error: message.text() }); });
          page.on('response', response => { if (response.status() >= 400) report.errors.push({ case: name, kind: 'http', url: response.url(), status: response.status() }); });
          gate = createTaskRequestGate(action => record({ case: name, ...action }));
          await page.route('**/api/**', gate.handle); await installDOMSignals(page);
          const activity = gate.next(activityPath), polling = gate.next(pollPath);
          const serverSubscribed = fixture.base.wait('frame', frame => frame.type === 'sessions.subscribe' && frame.mode === 'all_live');
          const subscribed = observed.wait(row => row.direction === 'sent' && row.frame?.type === 'sessions.subscribe' && row.frame.mode === 'all_live', { label: 'initial overview subscription' });
          const entries = observed.wait(row => row.direction === 'received' && row.frame?.type === 'entries' && row.frame.final, { label: 'initial final history' });
          await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
          await Promise.all([subscribed, serverSubscribed]); assert.equal((await entries).frame.entries.length, 160);
          await page.evaluate(() => window.__dagQA.done(window.__dagQA.initial));
          const [activityToken, pollToken] = await Promise.all([activity, polling]);
          const completed = taskRow('completed', 2), stale = taskRow('running', 1);
          if (scenario === 'ws-first') {
            await overview([overviewFrame(rows(completed))], 'newer-WS-before-held-REST');
            await attached([taskFrame(rows(completed))], 'attached-newer-before-held-history');
            // The REST-only marker is a different revision so it proves this reply was consumed.
            restMarker = { ...restMarker, name: `rest-${prefix}-1`, updated_at: stamp(31) };
            await poll(pollToken, stale, 'stale-REST-after-newer-WS');
            assert.equal((await page.evaluate(readTaskDOM)).sidebarRunning, 0);
            await hydrate(activityToken, stale, 'stale-history-after-newer-attached'); await check('completed');
          } else if (scenario === 'digest-alias') {
            const correction = taskRow('completed', 2, { raw_status: 'running' });
            const compact = rows(correction).map(({ task_id, status, updated_at, raw_status }) => ({ task_id, status, updated_at, ...(raw_status ? { raw_status } : {}) }));
            await poll(pollToken, null, 'digest-only-REST', { task: null, task_oversized: true, task_digest: { tasks: compact, truncated: true } });
            const digestFrame = overviewFrame([], { sessionId: 'qa-durable', durableSessionId: 'qa-durable',
              snapshots: [{ name: 'omo.task.updated', oversized: true }], taskDigest: { tasks: compact, truncated: true } });
            await overview([digestFrame, overviewFrame([], { durableSessionId: 'qa-durable', replacesSessionId: 'qa-durable',
              snapshots: [{ name: 'omo.task.updated', data: { tasks: [], truncated_tasks: true }, oversized: false }] })], 'digest-only-WS-alias-migration');
            assert.equal((await page.evaluate(readTaskDOM)).sidebarRunning, 0);
            await hydrate(activityToken, correction, 'rich-history-enrichment'); await check('completed');
            await overview([overviewFrame(rows(stale), { sessionId: 'qa-durable', durableSessionId: 'qa-durable' })], 'stale-rich-old-alias');
            await attached([taskFrame(rows(stale))], 'stale-attached-after-compact-correction'); await check('completed');
            await push(taskRow('running', 3), 'newer-revival-after-digest-alias', 'running');
          } else {
            const baseline = ['heartbeat-completion', 'derived-revival'].includes(scenario) ? stale : completed;
            await poll(pollToken, baseline, 'initial-REST');
            if (scenario === 'rest-first') {
              await overview([overviewFrame(rows(stale))], 'stale-WS-after-newer-REST');
              assert.equal((await page.evaluate(readTaskDOM)).sidebarRunning, 0, 'REST-first rollback rejected before attached hydration');
            }
            await hydrate(activityToken, baseline, 'initial-history'); await check(baseline.status);
            if (scenario === 'raw-stale' || scenario === 'rest-first') {
              await push(stale, 'raw-completed-1002-then-stale-running-1001', 'completed');
            } else if (scenario === 'heartbeat-completion') {
              const activity = { type: 'extensionEvent', name: 'omo.dag.activity', data: { runId: 'ordering-run', nodeId: 'ordering-node', taskId: 'child-1',
                at: stamp(4), currentTool: `activity-${prefix}`, lastAssistantLine: '작업 heartbeat 진행 기록', turns: 7 } };
              await attached([dagFrame('running', 1), activity,
                { type: 'extensionEvent', name: 'omo.dag.heartbeat', data: { at: stamp(4), runs: [{ runId: 'ordering-run', headSeq: 7 }] } }], 'activity-and-heartbeat-1004');
              await check('running', { tool: activity.data.currentTool });
              await push(taskRow('completed', 3), 'raw-completion-1003-after-activity-1004', 'completed');
              await check('completed', { tool: activity.data.currentTool });
            } else if (scenario === 'derived-revival') {
              const correction = taskRow('completed', 1, { raw_status: 'running' });
              await attached([dagFrame('completed', 2)], 'terminal-DAG-evidence');
              await push(correction, 'matching-same-raw-revision-derived-correction', 'completed');
              await push(stale, 'equal-raw-replay-cannot-erase-correction', 'completed');
              await push(taskRow('running', 3), 'genuine-newer-same-ID-revival', 'running');
              await attached([dagFrame('completed', 2), taskFrame(rows(correction)), { type: 'run.started' }, { type: 'run.done', reason: 'stop' }], 'old-DAG-old-correction-parent-settlement-after-revival');
              await overview([overviewFrame(rows(correction))], 'old-correction-overview-after-revival'); await check('running');
            } else if (scenario === 'reconnect-clear') {
              const after = observed.mark(), request = gate.next(activityPath);
              const closed = observed.wait(row => row.kind === 'close', { after, label: 'native disconnect' });
              const created = observed.wait(row => row.direction === 'sent' && row.frame?.type === 'chat.create' && row.frame.chatId === chat, { after, label: 'native reconnect' });
              const final = observed.wait(row => row.direction === 'received' && row.frame?.type === 'entries' && row.frame.final, { after, label: 'reconnected transcript' });
              fixture.disconnect(chat);
              const [oldSocket, newSocket] = await Promise.all([closed, created, final]);
              assert.notEqual(oldSocket.socketId, newSocket.socketId);
              await attached([taskFrame(rows(stale))], 'stale-during-reconnect-held-history'); await check('completed');
              restMarker = { ...restMarker, name: `rest-${prefix}-1`, updated_at: stamp(31) };
              await hydrate(await request, null, 'explicit-REST-target-omission');
              await overview([overviewFrame(rows(null))], 'explicit-overview-target-omission'); await check('absent', { total: 1 });
              await overview([overviewFrame(rows(stale))], 'stale-after-clear-overview');
              await attached([taskFrame(rows(stale))], 'stale-after-clear-attached'); await check('absent', { total: 1 });
              await push(taskRow('running', 5), 'genuine-newer-revival-after-clear', 'running');
            }
          }
          await capture('final');
          // Exercise a real scroll event against the long transcript; subscribe first.
          const scroll = await armDOM(page, () => document.querySelector('.th-chat-body')?.scrollTop <= 1);
          await page.locator('.th-chat-body').evaluate(node => node.scrollTo({ top: 0, behavior: 'instant' })); await doneDOM(page, scroll);
          await capture('transcript-top');
          if (viewport.width === 390) {
            const open = await armDOM(page, () => document.querySelector('.th-sidebar')?.getAttribute('aria-hidden') !== 'true' && !!document.querySelector('.th-backdrop'));
            await page.locator('.th-mobile-menu').click(); await doneDOM(page, open); await capture('sidebar-agreement', { drawer: true });
            const close = await armDOM(page, () => document.querySelector('.th-sidebar')?.getAttribute('aria-hidden') === 'true' && !document.querySelector('.th-backdrop'));
            await page.locator('.th-backdrop').click({ position: { x: 380, y: 100 } }); await doneDOM(page, close); await capture('drawer-closed');
          }
          assert.equal(fixture.base.frames.filter(frame => frame.type === 'chat.send').length, 0, 'no prompts sent');
          assert.deepEqual(fixture.base.unexpected, []); assert.deepEqual(fixture.errors, []);
          assert.deepEqual(report.errors.filter(row => row.case === name), []); result.passed = true;
        } catch (error) {
          result.error = { message: error.message, stack: error.stack };
          if (page && !page.isClosed()) {
            await writeFile(join(evidenceDir, `${name}-failure.html`), await page.content());
            await page.screenshot({ path: join(evidenceDir, `${name}-failure.png`), fullPage: false });
          }
          throw error;
        } finally {
          const clean = async (key, action) => { try { receipt[key] = await action() ?? true; }
            catch (error) { receipt.errors.push({ key, error: String(error) }); } };
          if (gate) await clean('routes', async () => { const value = await gate.stop(); assert.deepEqual(value.errors, []); return value; });
          if (page && !page.isClosed()) await clean('domObservers', () => page.evaluate(() => window.__dagQA?.stop() ?? 0));
          observed?.stop();
          if (context) await clean('contextClosed', () => context.close());
          if (fixture) {
            await clean('fixture', () => fixture.stop());
            await clean('portsReleased', async () => Promise.all([fixture.url, fixture.base.url].map(url => confirmPortReleased(Number(new URL(url).port)))));
          }
          await save(evidenceDir, `${name}-websocket-timeline.json`, observed?.timeline ?? []);
          await save(evidenceDir, `${name}-fixture-traffic.json`, { proxy: fixture?.traffic ?? [], base: fixture?.base.traffic ?? [] });
          cleanup.errors.push(...receipt.errors.map(error => ({ case: name, ...error })));
        }
      }
    }
    assert.deepEqual(cleanup.errors, []); report.passed = true;
  } catch (error) { failure = error; report.error = { message: error.message, stack: error.stack }; }
  finally {
    if (browser && !suppliedBrowser) {
      try { await browser.close(); cleanup.browserClosed = !browser.isConnected(); }
      catch (error) { cleanup.errors.push({ key: 'browser', error: String(error) }); }
    }
    if (suppliedBrowser) cleanup.callerBrowserRetained = true;
    if (assets) {
      try { await rm(assets.directory, { recursive: true, force: true }); await assert.rejects(access(assets.directory), { code: 'ENOENT' }); cleanup.assetsRemoved = true; }
      catch (error) { cleanup.errors.push({ key: 'assets', error: String(error) }); }
    }
    report.passed = report.passed && cleanup.errors.length === 0;
    report.finishedAt = new Date().toISOString();
    await save(evidenceDir, 'browser-actions.json', report); await save(evidenceDir, 'browser-errors.json', report.errors);
    await save(evidenceDir, 'cleanup.json', cleanup);
  }
  if (failure) throw failure;
  assert.deepEqual(cleanup.errors, []); return { ...report, cleanup };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const report = await run(parseArgs(process.argv.slice(2))); console.log(JSON.stringify({ passed: report.passed, cleanup: report.cleanup }, null, 2)); }
  catch (error) { console.error(error.stack); process.exitCode = 1; }
}
