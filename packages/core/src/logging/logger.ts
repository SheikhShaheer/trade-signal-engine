export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levelRank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function serialise(fields: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value instanceof Error) {
      parts.push(`${key}="${value.message}"`);
    } else if (typeof value === 'object') {
      parts.push(`${key}=${JSON.stringify(value)}`);
    } else if (typeof value === 'string' && /[\s"]/.test(value)) {
      parts.push(`${key}="${value.replace(/"/g, "'")}"`);
    } else {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.join(' ');
}

export function createLogger(level: LogLevel = 'info', bindings: Record<string, unknown> = {}): Logger {
  const threshold = levelRank[level];

  const emit = (msgLevel: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (levelRank[msgLevel] < threshold) return;
    const merged = { ...bindings, ...(fields ?? {}) };
    const suffix = Object.keys(merged).length > 0 ? ` ${serialise(merged)}` : '';
    const line = `${new Date().toISOString()} ${msgLevel.toUpperCase().padEnd(5)} ${message}${suffix}`;
    if (msgLevel === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
