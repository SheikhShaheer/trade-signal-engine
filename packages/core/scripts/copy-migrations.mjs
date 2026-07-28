import { cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * tsc emits only TypeScript output, so the .sql migrations have to be copied
 * into dist/ alongside it. Without this the compiled package resolves an empty
 * migrations directory and silently applies nothing.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src/db/migrations');
const destination = path.join(root, 'dist/db/migrations');

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });

const files = (await readdir(destination)).filter((f) => f.endsWith('.sql'));
if (files.length === 0) {
  process.stderr.write('copy-migrations: no .sql files were copied\n');
  process.exit(1);
}
process.stdout.write(`copy-migrations: ${files.length} migration(s) copied to dist\n`);
