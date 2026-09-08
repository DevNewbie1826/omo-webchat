import assert from 'node:assert/strict';
import { mkdtemp, rm, access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { chromePath, loadDriver, startCompleteFixture, transcript } from './dag-complete-fixture.mjs';
import { browserGate, actionDOM, setupDOM } from './dag-complete-browser.mjs';
import { assertComplete, bounded, detailPath, longRunIDs } from './dag-complete-controls.mjs';
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
