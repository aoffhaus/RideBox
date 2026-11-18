import type { Settings } from '../storage/db';

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
