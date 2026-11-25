// Ride photos: a couple of screenshots of the 3D world taken during the ride, like
// Zwift's. Strava's public API can't attach photos, so they're kept on this device
// (not synced) and offered on the ride summary to share or save, then add on Strava.
//
// Two shots are kept per ride:
//   - "highlight": taken during the ride's hardest effort (after a warm-up): once the
//     rolling 30 s power has kept setting new highs for 10 s in a row, so the rider is
//     well into the effort and the world's effort effects are showing,
//   - "scenic": refreshed every few minutes, so it ends up near the end of the ride.

import type { Sample } from './recorder';

export type PhotoKind = 'highlight' | 'scenic';

export const PHOTO_WARMUP_S = 300; // no highlights in the first 5 min
export const HIGHLIGHT_RISE_S = 10; // the 30 s power must climb this long before a highlight
export const HIGHLIGHT_GAP_S = 45; // re-shoot a new peak at most this often
export const SCENIC_EVERY_S = 240;

/**
 * Decides, once per recorded sample, whether to take a photo now. Pure, so it can
 * be tested with synthetic samples; the ride screen does the actual capturing.
 */
export class PhotoPlanner {
  private best = 0;
  private lastHighlight = -Infinity;
  private riseStart = -1; // when the current run of new 30 s highs began (-1: none)
  private lastScenic = 0;
  private seen = 0;

  /** Call with the session's samples; returns what to shoot for the newest one, if anything. */
  tick(samples: readonly Sample[]): PhotoKind | null {
    if (samples.length === this.seen) return null;
    this.seen = samples.length;
    const s = samples[samples.length - 1];
    const t = s.elapsed;
    if (t >= PHOTO_WARMUP_S && samples.length >= 30) {
      let sum = 0;
      for (let i = samples.length - 30; i < samples.length; i++) sum += samples[i].power;
      const p30 = sum / 30;
      if (p30 > this.best) {
        this.best = p30;
        if (this.riseStart < 0) this.riseStart = t;
      } else {
        this.riseStart = -1;
      }
    }
    if (s.power <= 0) return null; // coasting or stopped: not much of a picture
    if (this.riseStart >= 0 && t - this.riseStart >= HIGHLIGHT_RISE_S && t - this.lastHighlight >= HIGHLIGHT_GAP_S) {
      this.lastHighlight = t;
      return 'highlight';
    }
    if (t - this.lastScenic >= SCENIC_EVERY_S) {
      this.lastScenic = t;
      return 'scenic';
    }
    return null;
  }
}

/** Highlight first, then the scenic shot. */
export function orderedPhotos(photos: Map<PhotoKind, Blob>): Blob[] {
  return (['highlight', 'scenic'] as const).map((k) => photos.get(k)).filter((b): b is Blob => !!b);
}
