import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qaDriverSkipOption, resolveQaDriver } from './qa-driver.mjs';

describe('QA browser driver resolution', () => {
  test('uses an existing environment driver file', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'qa-driver-'));
    try {
      const entry = join(tempDir, 'playwright.mjs');
      await writeFile(entry, '');
      await expect(resolveQaDriver({ env: entry })).resolves.toEqual({
        status: 'env',
        entry,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects a missing environment driver file', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'qa-driver-'));
    try {
      await expect(
        resolveQaDriver({ env: join(tempDir, 'missing.mjs') }),
      ).rejects.toThrow('QA_PLAYWRIGHT');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('uses a valid receipt driver entry', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'qa-driver-'));
    try {
      const entry = join(tempDir, 'playwright.mjs');
      const receiptPath = join(tempDir, '.omo', 'qa-driver.json');
      await mkdir(join(tempDir, '.omo'));
      await writeFile(entry, '');
      await writeFile(
        receiptPath,
        JSON.stringify({ qa_driver: { absolute_import_entry: entry } }),
      );
      await expect(resolveQaDriver({ env: '', receiptPath })).resolves.toEqual({
        status: 'receipt',
        entry,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects a receipt pointing to a missing driver file', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'qa-driver-'));
    try {
      const entry = join(tempDir, 'missing-playwright.mjs');
      const receiptPath = join(tempDir, '.omo', 'qa-driver.json');
      await mkdir(join(tempDir, '.omo'));
      await writeFile(
        receiptPath,
        JSON.stringify({ qa_driver: { absolute_import_entry: entry } }),
      );
      await expect(resolveQaDriver({ env: '', receiptPath })).rejects.toThrow(
        'qa-driver receipt points to a missing file',
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('reports unavailable when no receipt exists', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'qa-driver-'));
    try {
      const resolved = await resolveQaDriver({
        env: '',
        receiptPath: join(tempDir, 'missing.json'),
      });
      expect(resolved.status).toBe('unavailable');
      expect(resolved.reason).toContain('QA_PLAYWRIGHT');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('returns the test skip option only when unavailable', () => {
    const reason = 'no browser driver configured';
    expect(qaDriverSkipOption({ status: 'unavailable', reason })).toEqual({
      skip: reason,
    });
    expect(qaDriverSkipOption({ status: 'env', entry: '/driver.mjs' })).toEqual(
      {},
    );
  });
});
