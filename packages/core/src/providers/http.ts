import { ProviderError } from './types.js';

export interface HttpOptions {
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  provider: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * JSON GET with a timeout and bounded retries. 429 and 5xx are retried with
 * exponential backoff; 4xx other than 429 fail immediately, since retrying a
 * bad request just burns the rate limit.
 */
export async function fetchJson<T>(url: string, options: HttpOptions, headers: Record<string, string> = {}): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    if (attempt > 0) await sleep(options.retryBackoffMs * 2 ** (attempt - 1));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json', ...headers },
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const retryable = response.status === 429 || response.status >= 500;
        const error = new ProviderError(
          `${options.provider} responded ${response.status}: ${body.slice(0, 200)}`,
          options.provider,
          retryable,
        );
        if (!retryable) throw error;
        lastError = error;
        continue;
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof ProviderError && !error.retryable) throw error;
      const message = (error as Error).name === 'AbortError' ? `timed out after ${options.timeoutMs}ms` : (error as Error).message;
      lastError = new ProviderError(`${options.provider} request failed: ${message}`, options.provider, true);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new ProviderError(`${options.provider} request failed`, options.provider, true);
}
