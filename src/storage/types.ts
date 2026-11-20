// Plain record types and helpers shared by the app and the Worker (worker/mcp).
// Nothing here may touch IndexedDB or the DOM.

import type { Workout } from '../workout/model';

/** An FTP that took effect on a day (and lasted until the next change). */
export interface FtpChange {
  from: string; // DayKey
  ftp: number;
}

export interface Settings {
  ftp: number;
  /** past FTP changes, oldest first; Strava rides are judged at the FTP of their day */
  ftpHistory?: FtpChange[];
  riderKg: number;
  bikeKg: number;
  maxHr: number;
  units: 'imperial' | 'metric';
  /** 0–100: how much of the real road grade the trainer applies in SIM mode */
  simDifficulty: number;
  cda: number;
  /** 3D detail: 'low' for older / integrated-GPU computers */
  graphics: 'high' | 'low';
  /** visual-only vertical scale of the world (Zwift-style); 1 = true to life */
  gradeExaggeration: number;
  /** how strongly the world reacts to sustained effort (wind, sky, colour, glow): 0 off … 1.5 dramatic */
  effortReactions: number;
  /** strength of the sprint rush (speed blur, wider view, glow flare): 0 off … 1.5 dramatic */
  sprintEffect: number;
}

export const DEFAULT_SETTINGS: Settings = {
  ftp: 200,
  riderKg: 75,
  bikeKg: 9,
  maxHr: 185,
  units: 'imperial',
  simDifficulty: 50,
  cda: 0.32,
  graphics: 'high',
  gradeExaggeration: 1.8,
  effortReactions: 1,
  sprintEffect: 1,
};

/** Human label for the effort-reactions slider. */
export function reactLabel(k: number) {
  return k <= 0 ? 'Off' : k < 0.75 ? 'Subtle' : k <= 1.15 ? 'Normal' : 'Dramatic';
}

export interface StoredWorkout {
  id: string;
  workout: Workout;
  source: string; // 'builtin' | 'import' | 'builder' | 'trainerroad' ...
  createdAt: number;
  favorite?: boolean;
}

/** Short random id for new records. */
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
