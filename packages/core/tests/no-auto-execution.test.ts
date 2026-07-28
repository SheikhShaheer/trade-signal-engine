import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';

/**
 * The design constraint from the specification, enforced as a test.
 *
 * There must be no code path from "signal detected" to "trade executed". These
 * tests fail the build if anyone adds order-placement code, a signed exchange
 * endpoint, or an API credential, so the constraint survives future edits
 * rather than living only in a comment.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const scannedDirs = [
  path.join(repoRoot, 'packages/core/src'),
  path.join(repoRoot, 'apps/api/src'),
  path.join(repoRoot, 'apps/worker/src'),
  path.join(repoRoot, 'apps/dashboard/src'),
];

/** Endpoints and calls that would mean the system can act on its own. */
const forbiddenPatterns: { pattern: RegExp; why: string }[] = [
  { pattern: /\/api\/v3\/order\b/, why: 'Binance order endpoint' },
  { pattern: /\bsapi\/v\d/, why: 'Binance signed account endpoint' },
  { pattern: /createOrder|placeOrder|submitOrder|sendOrder|newOrder/i, why: 'order-placement call' },
  { pattern: /\bccxt\b/, why: 'exchange execution library' },
  { pattern: /X-MBX-APIKEY/i, why: 'Binance authenticated request header' },
  { pattern: /BINANCE_(API_)?SECRET|API_SECRET|SECRET_KEY/, why: 'trading credential' },
  { pattern: /createHmac\s*\(/, why: 'request signing, which only signed (account) endpoints need' },
  { pattern: /marketBuy|marketSell|limitBuy|limitSell/i, why: 'order helper' },
  { pattern: /executeTrade|autoExecute|autoTrade/i, why: 'auto-execution path' },
];

async function collectSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next') continue;
      out.push(...(await collectSourceFiles(full)));
    } else if (/\.(ts|tsx|sql)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('no auto-execution', () => {
  it('has no order-placement or credential code anywhere in the source tree', async () => {
    const files = (await Promise.all(scannedDirs.map(collectSourceFiles))).flat();
    expect(files.length).toBeGreaterThan(10);

    const violations: string[] = [];
    for (const file of files) {
      // This test file necessarily contains the patterns it searches for.
      if (file.endsWith('no-auto-execution.test.ts')) continue;
      const contents = await readFile(file, 'utf8');
      for (const { pattern, why } of forbiddenPatterns) {
        if (pattern.test(contents)) {
          violations.push(`${path.relative(repoRoot, file)} matches ${pattern} (${why})`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('exposes no exported function whose name suggests execution', () => {
    const suspicious = Object.keys(core).filter((name) =>
      /order|execute|buy|sell|trade(?!Plan|PlanBuilder|PlanRepository)/i.test(name),
    );
    expect(suspicious).toEqual([]);
  });

  it('gives the market data provider a read-only interface', () => {
    const provider = new core.BinanceProvider({
      baseUrl: 'https://example.invalid',
      timeoutMs: 1,
      maxRetries: 0,
      retryBackoffMs: 0,
    });

    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(provider)).filter((m) => m !== 'constructor');
    expect(methods.sort()).toEqual(['assertSymbolSupported', 'getCandles', 'getLastPrice']);
  });

  it('has no database table that could record an engine-initiated order', async () => {
    const migrationsDir = path.join(repoRoot, 'packages/core/src/db/migrations');
    const files = await readdir(migrationsDir);
    const tableNames: string[] = [];

    for (const file of files) {
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/gi)) {
        tableNames.push((match[1] as string).toLowerCase());
      }
    }

    expect(tableNames.length).toBeGreaterThan(5);
    expect(tableNames.filter((t) => /order|execution|fill/.test(t))).toEqual([]);
  });

  it('routes every queued memo through a review row that requires a human actor', async () => {
    const schema = await readFile(
      path.join(repoRoot, 'packages/core/src/db/migrations/001_init.sql'),
      'utf8',
    );
    // A queued memo is only ever actioned by updating review_queue, and every
    // action writes an actor into the audit log.
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS review_queue/);
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS review_audit_log/);
    expect(schema).toMatch(/actor\s+TEXT NOT NULL/);
  });
});
