import { describe, expect, it } from 'vitest';
import { formatQuantity } from '../src/execution/binance-testnet-client.js';

describe('formatQuantity', () => {
  it('rounds down to instrument step', () => {
    expect(formatQuantity(0.0123456, 0.00001)).toBe('0.01234');
    expect(formatQuantity(1.5, 0.1)).toBe('1.5');
  });
});

describe('RoutingExecutionProvider', () => {
  it('exports createExecutionProvider from factory', async () => {
    const { createExecutionProvider, RoutingExecutionProvider } = await import('../src/execution/index.js');
    expect(createExecutionProvider).toBeDefined();
    expect(RoutingExecutionProvider).toBeDefined();
  });
});
