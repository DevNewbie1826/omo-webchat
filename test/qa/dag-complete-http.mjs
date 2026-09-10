import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { assertComplete, catalogPageSize, catalogPath, detailPath, longRunIDs } from './dag-complete-controls.mjs';
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
    const pages = [], seen = [], cursors = new Set(); let cursor = null;
    do {
      const query = `?limit=${catalogPageSize}` + (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`);
      const page = await get(catalogPath + query); pages.push(page);
      assert.ok(Array.isArray(page.runs));
      assert.ok(page.runs.length <= catalogPageSize, `catalog page larger than ${catalogPageSize}`);
      if (cursor === null) assert.equal(page.runs.length, catalogPageSize);
      for (const row of page.runs) {
        assert.equal(seen.includes(row.run_id), false, `duplicate ${row.run_id}`);
        seen.push(row.run_id);
        assert.equal(typeof row.updated_at, 'string');
      }
      for (let index = 1; index < page.runs.length; index++) {
        const newer = Date.parse(page.runs[index - 1].updated_at), older = Date.parse(page.runs[index].updated_at);
        // The catalog's total order is updated_at DESC with a run_id DESC
        // tiebreak (the same order the keyset cursor walks).
        assert.ok(newer > older || (newer === older && page.runs[index - 1].run_id > page.runs[index].run_id),
          'catalog page is updated_at DESC, run_id DESC on ties');
      }
      cursor = page.next_cursor;
      assert.ok(cursor === null || typeof cursor === 'string');
      if (cursor !== null) { assert.equal(cursors.has(cursor), false, 'cursor cycle'); cursors.add(cursor); }
    } while (cursor !== null);
    assert.deepEqual(seen, fixture.manifest.newestFirst);
    assert.deepEqual([...seen].sort(), fixture.manifest.runs);
    assert.equal(pages[0].runs.map(row => row.run_id).join('\n'), fixture.manifest.newestFirst.slice(0, catalogPageSize).join('\n'));
    await save(evidenceDir, 'C1-catalog.json', { pages, observed: seen, newestFirst: fixture.manifest.newestFirst,
      expected: fixture.manifest.runs, pageSize: catalogPageSize, passed: true });
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
