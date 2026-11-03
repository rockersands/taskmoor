import { describe, expect, it } from 'vitest';
import { inBatches } from './load-agile';

describe('loading a sprint with very many tickets', () => {
  it('[IMP-001] splits its tickets so no statement passes the 65,535 parameter limit', () => {
    const tickets = Array.from({ length: 70_000 }, (_, i) => i);
    const parts = inBatches(tickets);
    // Five parameters a row when a sprint's tickets are inserted.
    for (const part of parts) expect(part.length * 5).toBeLessThanOrEqual(65_535);
    expect(parts.flat()).toEqual(tickets);
    expect(inBatches([])).toEqual([]);
  });
});
