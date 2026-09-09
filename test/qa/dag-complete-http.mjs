import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { assertComplete, catalogPath, detailPath, longRunIDs } from './dag-complete-controls.mjs';
import { save } from './dag-complete-fixture.mjs';

/** The response object here comes from Playwright's native HTTP client, not a
 * mocked route. Both successful documents and guard failures retain raw bytes. */
export async function httpAudit({ fixture, request, evidenceDir }) {
  const receipts = [];
  async function get(path, expectedStatus = 200, options = {}) {
    const response = await request.fetch(fixture.url + path, { maxRedirects: 0, timeout: 30000, ...options });
    const body = await response.text();
    receipts.push({ path, method: options.method ?? 'GET', status: response.status(), statusText: response.statusText(),
      headers: await response.headersArray(), body });
    assert.equal(response.status(), expectedStatus, `${path}: ${body.slice(0, 300)}`);
    return JSON.parse(body);
  }
  try {
    await get(detailPath('dense-64'), 401);
    await get('/api/login', 200, { method: 'POST', data: { password: 'dag-complete-isolated' } });
    await get('/api/auth/check');
    const pages = [], seen = new Set(), cursors = new Set(); let cursor = null;
    do {
      const page = await get(catalogPath + (cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`)); pages.push(page);
      assert.ok(Array.isArray(page.runs));
      for (const row of page.runs) { assert.equal(seen.has(row.run_id), false, `duplicate ${row.run_id}`); seen.add(row.run_id); }
      cursor = page.next_cursor;
      assert.ok(cursor === null || typeof cursor === 'string');
      if (cursor !== null) { assert.equal(cursors.has(cursor), false, 'cursor cycle'); cursors.add(cursor); }
    } while (cursor !== null);
    assert.deepEqual([...seen].sort(), fixture.manifest.runs);
    await save(evidenceDir, 'C1-catalog.json', { pages, observed: [...seen], expected: fixture.manifest.runs, passed: true });
    const documents = {};
    for (const id of ['dense-64', 'huge-record', 'long-identities', ...longRunIDs, ...Array.from({ length: 16 }, (_, i) => `multi-${String(i).padStart(2, '0')}`)]) {
      const document = await get(detailPath(id)); assertComplete(document, await fixture.expected(id)); documents[id] = document;
      const original = await readFile(join(fixture.storeRoot, fixture.manifest.files[id]));
      assert.equal(document.content_token, createHash('sha256').update(original).digest('hex'));
    }
    assert.equal((await get(detailPath('dense-64'))).content_token, documents['dense-64'].content_token);
    for (const path of [detailPath('dense-64').replace('qa-dag', 'other-workspace'),
      detailPath('dense-64').replace('qa-chat', 'other-chat'), detailPath('dense-64').replace('qa-chat', 'escape-chat'),
      detailPath('dense-64').replace('qa-chat', 'missing-chat'), detailPath('../dense-64')]) {
      const value = await get(path, 404); assert.equal(typeof value.error, 'string');
      assert.equal(JSON.stringify(value).includes(fixture.storeRoot), false, 'no source-path disclosure');
    }
    await get(catalogPath + '?cursor=not-a-valid-cursor', 400);
    await get('/api/workspaces/qa-dag/chats/malformed-chat/dag-runs/malformed', 422);
    return documents;
  } finally {
    await save(evidenceDir, 'qa-http-receipts.json', receipts);
    const raw = receipts.map(row => `${row.method} ${row.path}\nHTTP/1.1 ${row.status} ${row.statusText}\n${row.headers.map(header => `${header.name}: ${header.value}`).join('\n')}\n\n${row.body}`).join('\n\n');
    await writeFile(join(evidenceDir, 'C1-http.txt'), raw);
    await writeFile(join(evidenceDir, 'C4-http.txt'), raw);
  }
}
