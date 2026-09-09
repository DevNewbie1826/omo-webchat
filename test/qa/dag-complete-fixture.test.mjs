import assert from 'node:assert/strict';
import { mkdtemp, rm, access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { chromePath, loadDriver, startCompleteFixture, transcript } from './dag-complete-fixture.mjs';
import { browserGate, actionDOM, setupDOM, prepareSubagentsScenario, armDOM, doneDOM } from './dag-complete-browser.mjs';
import { assertComplete, bounded, detailPath, longRunIDs } from './dag-complete-controls.mjs';
import { observeSockets } from './heartbeat-liveness.mjs';
import { confirmPortReleased } from './dag-state-ordering.mjs';

test('transcript seed has exactly 100 causally linked original messages', () => {
  const entries = transcript(); assert.equal(entries.length, 100);
  assert.equal(new Set(entries.map(entry => entry.id)).size, 100);
  entries.forEach((entry, index) => assert.equal(entry.parentId, index ? entries[index - 1].id : null));
});

test('real Chrome machinery holds actual Go 401 responses and exact DOM barriers; all owned resources close', { timeout: 120000 }, async () => {
  assert.ok(globalThis.Bun, 'Run this suite using bun test');
  const evidenceDir = await mkdtemp(join(tmpdir(), 'dag-machinery-evidence-'));
  const profile = await mkdtemp(join(tmpdir(), 'dag-machinery-profile-'));
  let fixture, context, gate, page, port, root;
  const cleanup = { errors: [], profile, console: [] };
  try {
    fixture = await startCompleteFixture({ evidenceDir, port: 0 }); root = fixture.storeRoot;
    port = Number(new URL(fixture.url).port);
    assert.equal(fixture.manifest.runs.length, 539);
    const before = await fixture.source('dense-64'), next = structuredClone(before); next.nodes[0].attempt = 7;
    await fixture.replace('dense-64', next); assert.equal((await fixture.source('dense-64')).nodes[0].attempt, 7);
    await fixture.replace('dense-64', before); assert.deepEqual(await fixture.source('dense-64'), before);
    context = await (await loadDriver()).launchPersistentContext(profile, { executablePath: chromePath, headless: true });
    await context.grantPermissions(['local-network-access'], { origin: fixture.url });
    page = context.pages()[0]; await setupDOM(page);
    page.on('console', message => { if (message.type() === 'error') cleanup.console.push(message.text()); });
    // Tiny document is deliberately NOT the SPA: this suite proves automation,
    // while the lead's separate invocation alone earns product surface evidence.
    await page.route('**/qa-machinery', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><output></output></body></html>' }));
    await page.goto(fixture.url + '/qa-machinery');
    const receipts = []; gate = await browserGate(page, receipts);
    const first = gate.arm('dense-64'), second = gate.arm('history-001');
    await page.evaluate(paths => {
      window.received = [];
      window.requests = paths.map(path => fetch(path).then(async response => {
        const value = { path, status: response.status, body: await response.json() };
        window.received.push(value); document.querySelector('output').dataset.count = String(window.received.length); return value;
      }));
    }, [detailPath('dense-64'), detailPath('history-001')]);
    await Promise.all([first.captured, second.captured]);
    assert.equal(first.receipt.status, 401); assert.equal(second.receipt.status, 401);
    assert.equal(first.receipt.headers['content-type'].includes('application/json'), true);
    assert.deepEqual(await page.evaluate(() => window.received), []);
    await actionDOM(page, () => document.querySelector('output').dataset.count === '1', async () => second.release());
    assert.equal((await page.evaluate(() => window.received))[0].path, detailPath('history-001'));
    assert.equal(first.state, 'held');
    await actionDOM(page, () => document.querySelector('output').dataset.count === '2', async () => first.release());
    await page.evaluate(() => Promise.all(window.requests));
    assert.equal(receipts.length, 2);
    const abandoned = gate.arm('dense-64');
    await page.evaluate(path => {
      window.cancellation = new AbortController();
      window.abandoned = fetch(path, { signal: window.cancellation.signal }).catch(error => error.name);
    }, detailPath('dense-64'));
    await abandoned.captured;
    const aborted = page.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).pathname === detailPath('dense-64') });
    await page.evaluate(() => window.cancellation.abort()); await aborted;
    abandoned.release(); assert.equal(await page.evaluate(() => window.abandoned), 'AbortError');
    const login = await context.request.post(fixture.url + '/api/login', { data: { password: 'dag-complete-isolated' } });
    assert.equal(login.status(), 200);
    assert.equal((await context.request.get(fixture.url + '/api/auth/check')).status(), 200);
    // Unclaimed initial-discovery barriers accept the exact incoming run ID.
    const wildcard = gate.arm('*');
    await page.evaluate(path => { window.extra = fetch(path); }, detailPath('history-002'));
    await wildcard.captured; assert.equal(wildcard.receipt.path, detailPath('history-002'));
    wildcard.release(); await page.evaluate(() => window.extra.then(response => response.text()));
    const tokens = [];
    for (const id of longRunIDs) {
      const exact = gate.arm(id);
      await page.evaluate(path => { window.extra = fetch(path).then(response => response.json()); }, detailPath(id));
      await exact.captured; assert.equal(exact.receipt.status, 200); exact.release();
      const document = await page.evaluate(() => window.extra);
      assertComplete(document, await fixture.expected(id)); tokens.push(document.content_token);
    }
    assert.notEqual(tokens[0], tokens[1]);
    assert.equal((await context.request.get(fixture.url + detailPath(longRunIDs[0].slice(0, 512)))).status(), 404);
    // Real same-version checkpoint replacement has a different byte token,
    // not a newer chronology. Browser admission is tested by the lead's SPA run.
    const pairSource = await fixture.source('long-identities');
    const oldPair = await (await context.request.get(fixture.url + detailPath('long-identities'))).json();
    const pairNext = structuredClone(pairSource); pairNext.nodes[0].state = 'completed';
    await fixture.replace('long-identities', pairNext);
    const newPair = await (await context.request.get(fixture.url + detailPath('long-identities'))).json();
    assert.equal(newPair.run.updated_at, oldPair.run.updated_at);
    assert.notEqual(newPair.content_token, oldPair.content_token);
    assert.equal(newPair.run.nodes[0].state, 'completed');
    assert.equal(oldPair.run.nodes[0].state, 'pending');
    await fixture.replace('long-identities', pairSource);
    cleanup.checkpointBoundaries = { exactRunLengths: longRunIDs.map(id => id.length), prefixStatus: 404, sameRevisionDifferentToken: true };
    // Native Chrome -> actual Go reverse proxy -> existing task/pane transports.
    for (let connection = 0; connection < 2; connection++) {
      await page.evaluate(() => {
        const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/v2/ws');
        window.nativeSocket = socket;
        window.nativeEntries = new Promise((resolve, reject) => {
          socket.addEventListener('message', event => {
            const frame = JSON.parse(event.data);
            if (frame.type === 'entries' && frame.final) resolve(frame.entries);
          });
          socket.addEventListener('error', () => reject(new Error('native socket error')));
        });
        socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'chat.create', chatId: 'qa-chat', workspaceId: 'qa-dag', provider: 'omo' })));
      });
      assert.equal((await bounded(page.evaluate(() => window.nativeEntries), 'native transcript')).length, 100);
      if (connection === 0) {
        await page.evaluate(() => {
          window.nativeFrame = new Promise(resolve => window.nativeSocket.addEventListener('message', event => {
            const frame = JSON.parse(event.data); if (frame.name === 'qa-native-marker') resolve(frame);
          }));
          window.nativeClosed = new Promise(resolve => window.nativeSocket.addEventListener('close', event => resolve(event.code), { once: true }));
        });
        fixture.transport.deliver('qa-chat', { type: 'extensionEvent', name: 'qa-native-marker', data: { sequence: 1 } });
        assert.equal((await bounded(page.evaluate(() => window.nativeFrame), 'native frame')).data.sequence, 1);
        fixture.transport.disconnect('qa-chat');
        assert.equal(await bounded(page.evaluate(() => window.nativeClosed), 'native disconnect'), 1012);
      }
    }
    cleanup.nativeTransport = { attachments: 2, transcriptCount: 100, deliveredSequence: 1, closeCode: 1012 };
  } finally {
    const clean = async (key, operation) => { try { cleanup[key] = await operation() ?? true; } catch (error) { cleanup.errors.push({ key, error: String(error) }); } };
    if (gate) await clean('gate', async () => { const receipt = await gate.stop(); assert.equal(receipt.pending, 0); assert.deepEqual(receipt.errors, []); return receipt; });
    if (page && !page.isClosed()) await clean('DOMObservers', () => page.evaluate(() => window.__dagQA?.stop()));
    if (context) await clean('contextClosed', () => context.close());
    if (fixture) await clean('fixture', async () => { const receipt = await fixture.stop(); assert.deepEqual(receipt.errors, []); return receipt; });
    if (port) await clean('portReleased', () => confirmPortReleased(port));
    if (root) await clean('rootRemoved', () => assert.rejects(access(root), { code: 'ENOENT' }));
    await clean('profileRemoved', () => rm(profile, { recursive: true, force: true }));
    if (fixture) await clean('fixtureStderr', () => readFile(join(evidenceDir, 'qa-fixture-stderr.log'), 'utf8'));
    await clean('evidenceTempRemoved', () => rm(evidenceDir, { recursive: true, force: true }));
    if (process.env.QA_MACHINERY_EVIDENCE_DIR) {
      await mkdir(process.env.QA_MACHINERY_EVIDENCE_DIR, { recursive: true });
      await writeFile(join(process.env.QA_MACHINERY_EVIDENCE_DIR, 'qa-machinery-cleanup.json'), JSON.stringify(cleanup, null, 2) + '\n');
    }
    assert.deepEqual(cleanup.errors, []);
  }
});


test('responsive scenario rebinds and hydrates before selecting Subagents and advancing retained per-ID revisions', { timeout: 120000 }, async () => {
  // This tiny UI exercises the QA orchestration against the actual activity
  // reducer and native fixture transport. It is NOT product surface evidence.
  const evidenceDir = await mkdtemp(join(tmpdir(), 'dag-remount-machinery-'));
  let fixture, browser, page, observed;
  const cleanup = { errors: [] };
  try {
    fixture = await startCompleteFixture({ evidenceDir, port: 0 });
    const built = await Bun.build({ entrypoints: [join(import.meta.dirname, '../../frontend/src/features/split/activityState.ts')], target: 'browser' });
    assert.equal(built.success, true, JSON.stringify(built.logs));
    const reducer = await built.outputs[0].text();
    browser = await (await loadDriver()).launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.grantPermissions(['local-network-access'], { origin: fixture.url });
    assert.equal((await context.request.post(fixture.url + '/api/login', { data: { password: 'dag-complete-isolated' } })).status(), 200);
    page = await context.newPage(); await setupDOM(page); observed = observeSockets(page);
    const errors = []; page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/reducer.js', route => route.fulfill({ contentType: 'text/javascript', body: reducer }));
    await page.route('**/remount-machinery', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
      <button data-activity-tab="agents" aria-selected="false"><span class="th-activity-tab-count"></span></button>
      <div class="th-chat-input"><textarea></textarea></div><div class="th-chat-body"></div><main></main>
      <script type="module">
        import { emptyActivityState, applyActivityEvent, applyActivityHistorySnapshot } from '/reducer.js';
        import english from '/shipped-en.json' with { type: 'json' };
        const button = document.querySelector('button');
        const machine = window.machine = { state: emptyActivityState(), selected: false, historyApplied: false, delivered: [] };
        function render() {
          const runs = [...machine.state.dags.values()], nodes = runs.flatMap(run => run.nodes);
          const partial = machine.state.truncatedDags || runs.some(run => run.truncated);
          const running = nodes.filter(node => node.state === 'running').length;
          button.setAttribute('aria-selected', String(machine.selected));
          if (partial) button.title = english['activity.partial']; else button.removeAttribute('title');
          button.querySelector('span').textContent = partial ? (running ? running + '+' : '?') : (nodes.length ? running + '/' + nodes.length : '');
          const main = document.querySelector('main'); main.replaceChildren();
          if (!machine.selected) return;
          const panel = document.createElement('section'); panel.dataset.activityTabpanel = 'agents'; main.append(panel);
          for (const run of runs) for (const node of run.nodes) {
            const row = document.createElement('span'); row.className = 'th-activity-agent-name';
            row.textContent = '(' + run.name + ') - ' + (node.label ?? node.prompt); panel.append(row);
          }
          if (partial) { const note = document.createElement('p'); note.className = 'th-activity-partial'; note.textContent = english['activity.partial']; panel.append(note); }
        }
        button.onclick = () => { machine.selected = true; render(); };
        window.addEventListener('resize', () => { machine.selected = false; machine.state = emptyActivityState(); render(); });
        const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/v2/ws');
        socket.onopen = () => socket.send(JSON.stringify({ type: 'chat.create', chatId: 'qa-chat', wsId: 'qa-dag' }));
        socket.onmessage = async event => {
          const frame = JSON.parse(event.data);
          if (frame.type === 'ready') {
            const history = await fetch('/api/workspaces/qa-dag/chats/qa-chat/activity').then(response => response.json());
            machine.state = applyActivityHistorySnapshot(machine.state, 'omo.dag.updated', history.dag);
            machine.historyApplied = true; render();
          }
          if (frame.type === 'entries') document.querySelector('.th-chat-body').textContent = frame.entries.map(entry => entry.message.content).join('\\n');
          if (frame.type === 'extensionEvent') {
            machine.delivered.push(frame); machine.state = applyActivityEvent(machine.state, frame.name, frame.data); render();
          }
          if (frame.type === 'message') document.querySelector('.th-chat-body').append(frame.message.content);
        };
      </script>` }));
    await page.route('**/shipped-en.json', route => route.fulfill({ path: join(import.meta.dirname, '../../frontend/src/i18n/locales/en.json'), contentType: 'application/json' }));
    // Seed the already-reset pane that r3 encountered. Width equality cannot
    // restore its selected tab, native binding, or discarded controlled state.
    await page.route('**/qa-empty', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await page.goto(fixture.url + '/qa-empty');
    await page.setContent('<button data-activity-tab="agents" aria-selected="false"></button>');
    let sequence = 0;
    for (const [index, retained, partial, width] of [[0, 12, true, 1280], [1, 12, true, 390], [2, 1, true, 1280], [3, 1, true, 390], [4, 0, true, 1280], [5, 0, true, 390], [6, 2, false, 1280], [7, 2, false, 390]]) {
      const source = await fixture.source(retained === 12 ? 'dense-64' : 'long-identities');
      for (const node of source.nodes) { node.state = 'running'; delete node.completedAt; }
      // The bounded overview sorts by creation time, not updated time. Put
      // this owned baseline first so the test really exercises a retained
      // watermark after clear, rather than an ID omitted by the 64 KiB budget.
      source.createdAt = `2026-09-08T10:30:0${index}Z`;
      source.updatedAt = `2026-09-08T11:00:${String(index * 2).padStart(2, '0')}Z`;
      await fixture.replace(source.runId, source);
      const priorRevision = source.updatedAt, revision = `2026-09-08T11:00:${String(index * 2 + 1).padStart(2, '0')}Z`;
      let capture, release;
      const captured = new Promise(resolve => { capture = resolve; });
      const released = new Promise(resolve => { release = resolve; });
      const activityHandler = async route => {
        const response = await route.fetch(); capture(); await released; await route.fulfill({ response });
      };
      await page.route('**/qa-chat/activity', activityHandler);
      const calls = [];
      const running = prepareSubagentsScenario({ page, observed, fixture: { ...fixture, async replace(id, record) {
        assert.equal(await page.evaluate(() => window.machine.historyApplied), true, 'REST must be applied, not merely downloaded');
        assert.equal(await page.locator('[data-activity-tab="agents"]').getAttribute('aria-selected'), 'true');
        assert.ok(Date.parse(record.updatedAt) > Date.parse(priorRevision)); calls.push('replace');
        await fixture.replace(id, record);
      } }, url: fixture.url + '/remount-machinery', viewport: { width, height: width === 390 ? 844 : 800 }, source, revision,
        options: { retained, partial }, async deliver(frame) {
          calls.push(frame.data.runs.length ? 'snapshot' : 'clear');
          const sentinel = `remount-delivery-${++sequence}`;
          const processed = await armDOM(page, value => document.querySelector('.th-chat-body')?.textContent.includes(value), sentinel);
          fixture.transport.deliver('qa-chat', frame);
          fixture.transport.deliver('qa-chat', { type: 'message', message: { role: 'assistant', content: sentinel } });
          await doneDOM(page, processed);
          if (!frame.data.runs.length) {
            // Real reducer retains the revision even when omission removes its row.
            const watermark = await page.evaluate(id => window.machine.state.dagFreshness.get(id), source.runId);
            assert.equal(watermark, Date.parse(priorRevision));
          }
        } });
      try {
        await Promise.race([running, bounded(captured, 'activity capture')]);
        assert.deepEqual(calls, [], 'no fixture mutation or controlled packet before held REST hydration');
        release();
        const result = await running;
        assert.equal(result.count, partial ? retained ? `${retained}+` : '?' : '2/2');
        assert.equal(result.selected, 'true');
        assert.equal(result.sourceRevision, revision);
        assert.equal(result.sourceCounts.running, retained === 12 ? 64 : 2);
        assert.deepEqual(calls, ['replace', 'clear', 'snapshot']);
        assert.equal(await page.evaluate(() => window.machine.delivered.length), 2);
        assert.deepEqual((await fixture.source(source.runId)).updatedAt, revision);
        assert.deepEqual(source.updatedAt, priorRevision, 'scenario does not mutate its fixed input');
      } finally { release(); await running.catch(() => {}); await page.unroute('**/qa-chat/activity', activityHandler); }
    }
    assert.deepEqual(errors, []);
  } finally {
    const clean = async (key, action) => { try { cleanup[key] = await action() ?? true; } catch (error) { cleanup.errors.push({ key, error: String(error) }); } };
    if (page && !page.isClosed()) await clean('DOMObservers', () => page.evaluate(() => window.__dagQA?.stop()));
    if (observed) observed.stop();
    if (browser) await clean('browserClosed', async () => { await browser.close(); assert.equal(browser.isConnected(), false); });
    if (fixture) await clean('fixture', () => fixture.stop());
    await clean('evidenceTempRemoved', () => rm(evidenceDir, { recursive: true, force: true }));
    if (process.env.QA_MACHINERY_EVIDENCE_DIR) await writeFile(join(process.env.QA_MACHINERY_EVIDENCE_DIR, 'qa-remount-cleanup.json'), JSON.stringify(cleanup, null, 2) + '\n');
    assert.deepEqual(cleanup.errors, []);
    if (cleanup.fixture) assert.deepEqual(cleanup.fixture.errors, []);
  }
});
