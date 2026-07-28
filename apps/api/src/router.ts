import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RequestContext {
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  body: unknown;
}

export type Handler = (ctx: RequestContext) => Promise<{ status: number; body: unknown }>;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Minimal router over node:http. Patterns use `:name` for path params, e.g.
 * `/api/memos/:id/review`.
 */
export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split('/').filter(Boolean),
      handler,
    });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler);
  }

  private match(method: string, path: string): { handler: Handler; params: Record<string, string> } | undefined {
    const parts = path.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const segment = route.segments[i] as string;
        const part = parts[i] as string;
        if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(part);
        else if (segment !== part) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: route.handler, params };
    }
    return undefined;
  }

  handle(allowedOrigins: readonly string[]): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
      void this.dispatch(req, res, allowedOrigins);
    };
  }

  private async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    allowedOrigins: readonly string[],
  ): Promise<void> {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const route = this.match(req.method ?? 'GET', url.pathname);

    if (!route) {
      this.send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const result = await route.handler({
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        params: route.params,
        body,
      });
      this.send(res, result.status, result.body);
    } catch (error) {
      if (error instanceof HttpError) {
        this.send(res, error.status, { error: error.message });
        return;
      }
      process.stderr.write(`unhandled api error: ${(error as Error).stack ?? (error as Error).message}\n`);
      this.send(res, 500, { error: 'internal error' });
    }
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body ?? null);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    });
    res.end(payload);
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') return undefined;

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;

  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}
