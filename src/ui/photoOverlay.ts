// The stats band drawn onto ride photos (see src/app/photos.ts), like Zwift's
// screenshots: live numbers along the bottom, the workout and interval top-left.

import type { Snapshot } from '../app/session';
import type { Settings } from '../storage/db';
import { formatDuration, zoneFor } from '../workout/model';
import { distUnit, fmtDist, fmtSpeed, r0, speedUnit } from './format';

export interface PhotoStat {
  label: string;
  value: string;
  unit: string;
  color?: string;
}

export interface PhotoStats {
  stats: PhotoStat[];
  /** workout name, e.g. "Sweet Spot 3x12" (free rides: the route) */
  title: string;
  /** current interval and target, e.g. "Sweet spot · 225 W" */
  subtitle?: string;
}

/** What goes on the photo, from the ride's state at the moment it's taken. */
export function photoStats(snap: Snapshot, settings: Settings, title: string): PhotoStats {
  const ftp = settings.ftp;
  const p = snap.power3s;
  const stats: PhotoStat[] = [
    { label: 'POWER', value: r0(p), unit: 'W', color: p > 0 && ftp > 0 ? zoneFor(p / ftp).color : undefined },
    { label: 'HEART RATE', value: r0(snap.hr), unit: 'bpm' },
    { label: 'CADENCE', value: r0(snap.cadence), unit: 'rpm' },
    { label: 'SPEED', value: fmtSpeed(snap.speed, settings), unit: speedUnit(settings) },
    { label: 'TIME', value: formatDuration(snap.elapsed), unit: '' },
    { label: 'DISTANCE', value: fmtDist(snap.distance, settings), unit: distUnit(settings) },
  ];
  const w = snap.workout;
  let subtitle: string | undefined;
  if (w && !w.finished && w.interval) {
    const target = w.targetWatts != null ? `${Math.round(w.targetWatts)} W` : 'free ride';
    subtitle = [w.interval.label, target].filter(Boolean).join(' · ');
  }
  return { stats, title, subtitle };
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Draws the band onto a photo canvas of size w × h. */
export function drawPhotoStats(ctx: CanvasRenderingContext2D, w: number, h: number, ps: PhotoStats) {
  const k = w / 1280; // designed at 1280 px wide
  ctx.save();
  ctx.textBaseline = 'alphabetic';

  // bottom band: a soft fade so the scene still shows through
  const bandH = 128 * k;
  const g = ctx.createLinearGradient(0, h - bandH * 1.5, 0, h);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.35, 'rgba(0,0,0,0.55)');
  g.addColorStop(1, 'rgba(0,0,0,0.78)');
  ctx.fillStyle = g;
  ctx.fillRect(0, h - bandH * 1.5, w, bandH * 1.5);

  const n = ps.stats.length;
  const pad = 36 * k;
  const col = (w - 2 * pad) / n;
  ps.stats.forEach((s, i) => {
    const cx = pad + col * i + col / 2;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = `600 ${15 * k}px ${FONT}`;
    ctx.fillText(s.label, cx, h - 88 * k);
    ctx.font = `700 ${46 * k}px ${FONT}`;
    const vw = ctx.measureText(s.value).width;
    ctx.font = `600 ${18 * k}px ${FONT}`;
    const uw = s.unit ? ctx.measureText(` ${s.unit}`).width : 0;
    const x0 = cx - (vw + uw) / 2;
    ctx.textAlign = 'left';
    ctx.font = `700 ${46 * k}px ${FONT}`;
    ctx.fillStyle = s.color ?? '#fff';
    ctx.fillText(s.value, x0, h - 38 * k);
    if (s.unit) {
      ctx.font = `600 ${18 * k}px ${FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillText(` ${s.unit}`, x0 + vw, h - 38 * k);
    }
  });

  // top-left: workout and interval
  const tg = ctx.createLinearGradient(0, 0, 0, 110 * k);
  tg.addColorStop(0, 'rgba(0,0,0,0.5)');
  tg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = tg;
  ctx.fillRect(0, 0, w, 110 * k);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${26 * k}px ${FONT}`;
  ctx.fillText(ps.title, pad, 46 * k);
  if (ps.subtitle) {
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = `500 ${18 * k}px ${FONT}`;
    ctx.fillText(ps.subtitle, pad, 74 * k);
  }

  // top-right: app mark
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = `800 ${20 * k}px ${FONT}`;
  ctx.fillText('RideBox', w - pad, 44 * k);
  ctx.restore();
}
