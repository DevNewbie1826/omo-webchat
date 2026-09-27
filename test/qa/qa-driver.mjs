import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultReceiptPath = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  '.omo/qa-driver.json',
);

export async function resolveQaDriver({
  env = process.env.QA_PLAYWRIGHT,
  receiptPath = defaultReceiptPath,
} = {}) {
  if (typeof env === 'string' && env.length > 0) {
    try {
      await access(env);
    } catch {
      throw new Error('QA_PLAYWRIGHT points to a missing file: ' + env);
    }
    return { status: 'env', entry: env };
  }

  let receipt;
  try {
    receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  } catch {
    return unavailable();
  }

  const entry = receipt?.qa_driver?.absolute_import_entry;
  if (typeof entry === 'string' && entry.length > 0) {
    try {
      await access(entry);
    } catch {
      throw new Error(
        'qa-driver receipt points to a missing file: ' +
          entry +
          ' (.omo/qa-driver.json)',
      );
    }
    return { status: 'receipt', entry };
  }

  return unavailable();
}

function unavailable() {
  return {
    status: 'unavailable',
    reason:
      'no browser driver configured: set QA_PLAYWRIGHT=<abs path to playwright-core index.mjs> or write .omo/qa-driver.json {"qa_driver":{"absolute_import_entry":"<abs path>"}}',
  };
}

export function qaDriverSkipOption(resolved) {
  return resolved.status === 'unavailable' ? { skip: resolved.reason } : {};
}
