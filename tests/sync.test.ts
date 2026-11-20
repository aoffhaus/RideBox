import { describe, expect, it } from 'vitest';
import { batchBySize, remoteWins } from '../src/storage/sync';

describe('sync merge rules', () => {
  it('newest write wins', () => {
    expect(remoteWins(5, undefined)).toBe(true);
    expect(remoteWins(5, 4)).toBe(true);
    expect(remoteWins(5, 5)).toBe(false);
    expect(remoteWins(4, 5)).toBe(false);
  });

  it('splits pushes by size and never drops a doc', () => {
    const docs = Array.from({ length: 10 }, (_, i) => ({ id: String(i), json: 'x'.repeat(1000) }));
    const batches = batchBySize(docs, 3000);
    expect(batches.flat()).toHaveLength(10);
    expect(batches.every((b) => b.length >= 1 && b.length <= 3)).toBe(true);
    // a single doc bigger than the limit still goes in its own batch
    expect(batchBySize([{ json: 'x'.repeat(10_000) }], 100)).toHaveLength(1);
  });
});
