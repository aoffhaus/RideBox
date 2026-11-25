// The ride's stat card: one of the ride photos (src/app/photos.ts) with the final
// ride stats laid over it, ready to share or add to the Strava activity. Built on
// the ride summary from the stored photo, so it always shows the ride's current name,
// focus and your units.

import type { RideRecord } from '../app/recorder';
import type { Settings } from '../storage/db';
import { rideFocus } from '../strava/uploadRide';
import { formatDuration, zoneFor } from '../workout/model';
import { distUnit, elevUnit, fmtDist, fmtElev, r0 } from './format';

export interface CardStat {
  label: string;
  value: string;
  unit: string;
  color?: string;
}

export interface StatCard {
  title: string;
  /** e.g. "Tue, Nov 24 · Sweet Spot · Rolling Farmland" */
  subtitle: string;
  stats: CardStat[]; // 8, laid out 4 × 2
}

/** The final stats that go on the card. */
export function statCard(ride: RideRecord, settings: Settings): StatCard {
  const s = ride.summary;
  const date = new Date(ride.startTime).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const subtitle = [date, rideFocus(ride), ride.workoutName ? undefined : ride.routeName].filter(Boolean).join(' · ');
  return {
    title: ride.name,
    subtitle,
    stats: [
      { label: 'TIME', value: formatDuration(s.duration), unit: '' },
      { label: 'DISTANCE', value: fmtDist(s.distance, settings), unit: distUnit(settings) },
      { label: 'AVG POWER', value: r0(s.avgPower), unit: 'W' },
      { label: 'NORM. POWER', value: r0(s.np), unit: 'W', color: s.np > 0 && ride.ftp > 0 ? zoneFor(s.np / ride.ftp).color : undefined },
      { label: 'TSS', value: r0(s.tss), unit: '' },
      { label: 'IF', value: s.if.toFixed(2), unit: '' },
      { label: 'AVG HR', value: r0(s.avgHr), unit: s.avgHr ? 'bpm' : '' },
      { label: 'CLIMBING', value: fmtElev(s.climb, settings), unit: elevUnit(settings) },
    ],
  };
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Draws the card's text and shading over a photo already drawn at w × h. */
export function drawStatCard(ctx: CanvasRenderingContext2D, w: number, h: number, card: StatCard) {
  const k = w / 1280; // designed at 1280 px wide
  const pad = 48 * k;
  ctx.save();
  ctx.textBaseline = 'alphabetic';

  // shade the lower part so the numbers read over any scene
  const panelH = Math.min(h * 0.62, 400 * k);
  const g = ctx.createLinearGradient(0, h - panelH, 0, h);
  g.addColorStop(0, 'rgba(8,10,16,0)');
  g.addColorStop(0.3, 'rgba(8,10,16,0.62)');
  g.addColorStop(1, 'rgba(8,10,16,0.88)');
  ctx.fillStyle = g;
  ctx.fillRect(0, h - panelH, w, panelH);

  // stats grid, 4 × 2, bottom-anchored
  const cols = 4;
  const colW = (w - 2 * pad) / cols;
  const rowH = 92 * k;
  const gridTop = h - pad - 2 * rowH;
  card.stats.forEach((s, i) => {
    const x = pad + (i % cols) * colW;
    const y = gridTop + Math.floor(i / cols) * rowH;
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    ctx.font = `600 ${15 * k}px ${FONT}`;
    ctx.fillText(s.label, x, y + 20 * k);
    ctx.fillStyle = s.color ?? '#fff';
    ctx.font = `700 ${48 * k}px ${FONT}`;
    ctx.fillText(s.value, x, y + 70 * k);
    if (s.unit) {
      const vw = ctx.measureText(s.value).width;
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.font = `600 ${20 * k}px ${FONT}`;
      ctx.fillText(` ${s.unit}`, x + vw, y + 70 * k);
    }
  });

  // title + subtitle above the grid, with a thin rule between
  const ruleY = gridTop - 14 * k;
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.fillRect(pad, ruleY, w - 2 * pad, Math.max(1, 1.5 * k));
  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  ctx.font = `500 ${20 * k}px ${FONT}`;
  ctx.fillText(card.subtitle, pad, ruleY - 20 * k);
  ctx.fillStyle = '#fff';
  ctx.font = `800 ${40 * k}px ${FONT}`;
  ctx.fillText(fit(ctx, card.title, w - 2 * pad), pad, ruleY - 56 * k);

  // app mark, top right
  ctx.textAlign = 'right';
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 8 * k;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = `800 ${22 * k}px ${FONT}`;
  ctx.fillText('RideBox', w - pad, 52 * k);
  ctx.restore();
}

/** Trims text with an ellipsis to fit `max` px in the current font. */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

/**
 * Renders the card as a JPEG: over `photo` if there is one, otherwise over a plain
 * dark backdrop (16:10).
 */
export async function renderStatCard(ride: RideRecord, settings: Settings, photo?: Blob): Promise<Blob> {
  const bmp = photo ? await createImageBitmap(photo) : undefined;
  const w = bmp?.width ?? 1280;
  const h = bmp?.height ?? 800;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  if (bmp) {
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
  } else {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#1d2a44');
    g.addColorStop(1, '#0b0f18');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  drawStatCard(ctx, w, h, statCard(ride, settings));
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Couldn’t make the stat card'))), 'image/jpeg', 0.9));
}
