import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const coreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executionDir = path.join(coreRoot, 'src', 'execution');

const allowedSigningFiles = new Set([
  path.join(executionDir, 'binance-testnet-client.ts'),
  path.join(executionDir, 'binance-testnet.ts'),
]);

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(full)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('no live credentials', () => {
  it('allows HMAC signing only in binance testnet modules', async () => {
    const files = await collectSourceFiles(executionDir);
    const offenders: string[] = [];

    for (const file of files) {
      const contents = await readFile(file, 'utf8');
      if (/createHmac\s*\(/.test(contents) && !allowedSigningFiles.has(file)) {
        offenders.push(path.relative(coreRoot, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('forbids mainnet order endpoints in execution code', async () => {
    const files = await collectSourceFiles(executionDir);
    const offenders: string[] = [];

    for (const file of files) {
      const contents = await readFile(file, 'utf8');
      if (/api\.binance\.com\/api\/v3\/order/.test(contents)) {
        offenders.push(path.relative(coreRoot, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('requires testnet host in the signed testnet client', async () => {
    const clientPath = path.join(executionDir, 'binance-testnet-client.ts');
    const contents = await readFile(clientPath, 'utf8');
    expect(contents).toContain('testnet.binance.vision');
    expect(contents).toMatch(/createHmac\s*\(/);
  });
});
