import { existsSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

/** Walk up from the current directory to find the repo-root .env file. */
function findEnvFile(): string | undefined {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    for (const name of ['.env.local', '.env']) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

let loaded = false;
function loadEnvFile(): void {
  if (loaded) return;
  loaded = true;
  const file = findEnvFile();
  if (file) dotenv.config({ path: file });
}

const envSchema = z.object({
  DATABASE_URL: z.string().default('postgres://tse:tse@localhost:5433/tse'),
  BINANCE_BASE_URL: z.string().url().default('https://api.binance.com'),
  BINANCE_TESTNET_BASE_URL: z.string().url().default('https://testnet.binance.vision'),
  BINANCE_TESTNET_API_KEY: z.string().optional(),
  BINANCE_TESTNET_API_SECRET: z.string().optional(),
  EXECUTION_MODE: z.enum(['paper', 'testnet', 'live']).default('paper'),
  NEWS_PROVIDER: z.enum(['stub', 'cryptopanic']).default('stub'),
  CRYPTOPANIC_API_KEY: z.string().optional(),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default('127.0.0.1'),
  REVIEWER_NAME: z.string().default('local-operator'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  loadEnvFile();
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (parsed.data.NEWS_PROVIDER === 'cryptopanic' && !parsed.data.CRYPTOPANIC_API_KEY) {
    throw new Error('NEWS_PROVIDER=cryptopanic requires CRYPTOPANIC_API_KEY to be set');
  }
  if (parsed.data.EXECUTION_MODE === 'testnet') {
    if (!parsed.data.BINANCE_TESTNET_API_KEY || !parsed.data.BINANCE_TESTNET_API_SECRET) {
      throw new Error('EXECUTION_MODE=testnet requires BINANCE_TESTNET_API_KEY and BINANCE_TESTNET_API_SECRET');
    }
  }
  cached = parsed.data;
  return cached;
}
