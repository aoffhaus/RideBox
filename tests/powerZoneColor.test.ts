import { describe, expect, it } from 'vitest';
import { contrastOnWhite, powerZoneColor } from '../src/ui/format';
import { ZONES } from '../src/workout/model';

describe('powerZoneColor', () => {
  it('uses the workout zone colour for current watts vs FTP', () => {
    // these zone colours already have enough contrast on the white HUD card
    expect(powerZoneColor(160, 250)).toBe(ZONES[1].color); // 64% Z2
  });

  it('gives a distinct, readable colour for every zone', () => {
    const watts = [100, 160, 200, 250, 280, 400]; // Z1..Z6 at FTP 250
    const colors = watts.map((w) => powerZoneColor(w, 250)!);
    expect(new Set(colors).size).toBe(6);
    for (const c of colors) expect(contrastOnWhite(c)).toBeGreaterThanOrEqual(3.5);
  });

  it('returns undefined without usable power or FTP', () => {
    expect(powerZoneColor(undefined, 250)).toBeUndefined();
    expect(powerZoneColor(null, 250)).toBeUndefined();
    expect(powerZoneColor(0, 250)).toBeUndefined();
    expect(powerZoneColor(NaN, 250)).toBeUndefined();
    expect(powerZoneColor(200, 0)).toBeUndefined();
    expect(powerZoneColor(200, undefined)).toBeUndefined();
  });
});
