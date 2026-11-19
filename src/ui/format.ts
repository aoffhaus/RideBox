import type { Settings } from '../storage/db';
import { zoneFor } from '../workout/model';

export function fmtSpeed(ms: number, s: Settings) {
  return s.units === 'imperial' ? (ms * 2.23694).toFixed(1) : (ms * 3.6).toFixed(1);
}
export const speedUnit = (s: Settings) => (s.units === 'imperial' ? 'mph' : 'km/h');

export function fmtDist(m: number, s: Settings) {
  return s.units === 'imperial' ? (m / 1609.344).toFixed(2) : (m / 1000).toFixed(2);
}
export const distUnit = (s: Settings) => (s.units === 'imperial' ? 'mi' : 'km');

export function fmtElev(m: number, s: Settings) {
  return s.units === 'imperial' ? Math.round(m * 3.28084).toString() : Math.round(m).toString();
}
export const elevUnit = (s: Settings) => (s.units === 'imperial' ? 'ft' : 'm');

export const r0 = (n: number | undefined) => (n == null || !Number.isFinite(n) ? '--' : Math.round(n).toString());

export function hrZoneColor(hr: number | undefined, maxHr: number) {
  if (!hr) return '#cfd6e0';
  const f = hr / maxHr;
  if (f < 0.6) return '#8a8f98';
  if (f < 0.7) return '#2f80ed';
  if (f < 0.8) return '#27ae60';
  if (f < 0.9) return '#f2c94c';
  return '#eb5757';
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

/** Contrast ratio (WCAG) of a #rrggbb colour against white. */
export function contrastOnWhite(hex: string): number {
  return 1.05 / (luminance(hex) + 0.05);
}

/** Darken a #rrggbb colour until it reaches `min` contrast against white. */
function readableOnWhite(hex: string, min: number): string {
  const n = parseInt(hex.slice(1), 16);
  let [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  let out = hex;
  for (let i = 0; i < 40 && contrastOnWhite(out) < min; i++) {
    r = Math.round(r * 0.92);
    g = Math.round(g * 0.92);
    b = Math.round(b * 0.92);
    out = '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
  }
  return out;
}

/**
 * Text colour for live power on the (white) HUD card: the workout zone colour
 * that `watts` falls in for the given FTP, darkened where needed (e.g. the
 * yellow threshold zone) to stay readable. Returns undefined when there is no
 * usable power or FTP, so callers can fall back to their default colour.
 */
export function powerZoneColor(watts: number | null | undefined, ftp: number | null | undefined): string | undefined {
  if (watts == null || !Number.isFinite(watts) || watts <= 0) return undefined;
  if (ftp == null || !Number.isFinite(ftp) || ftp <= 0) return undefined;
  return readableOnWhite(zoneFor(watts / ftp).color, 3.5);
}
