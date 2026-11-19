import { describe, expect, it } from 'vitest';
import { EDGE, squeezeRow } from '../src/world/themes/common';

const row = () => [-400, -150, -40, -12, -EDGE, EDGE, 12, 40, 150, 400];

describe('squeezeRow', () => {
  it('leaves rows that already fit untouched', () => {
    const offs = row();
    squeezeRow(offs, offs.length, 1e6, 1e6);
    expect(offs).toEqual(row());
  });

  it('fits the outer columns inside the limit on the tight side only', () => {
    const offs = row();
    squeezeRow(offs, offs.length, 1e6, 100);
    expect(Math.max(...offs)).toBeCloseTo(100, 6);
    expect(offs.slice(0, 5)).toEqual(row().slice(0, 5)); // the other side is unchanged
    expect(offs[5]).toBe(EDGE); // road edge stays put
  });

  it('keeps columns evenly ordered instead of piling them onto the limit', () => {
    const offs = row();
    squeezeRow(offs, offs.length, 60, 60);
    for (let c = 1; c < offs.length; c++) expect(offs[c]).toBeGreaterThan(offs[c - 1]);
    expect(new Set(offs.map((o) => o.toFixed(6))).size).toBe(offs.length); // no duplicates
    expect(Math.min(...offs)).toBeCloseTo(-60, 6);
  });
});
