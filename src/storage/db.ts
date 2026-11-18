import { openDB, type IDBPDatabase } from 'idb';
import type { Workout } from '../workout/model';
import type { RideRecord } from '../app/recorder';

export interface Settings {
  ftp: number;
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
};

export interface StoredWorkout {
  id: string;
  workout: Workout;
  source: string; // 'builtin' | 'import' | 'builder' | 'trainerroad' ...
  createdAt: number;
  favorite?: boolean;
}

let dbp: Promise<IDBPDatabase> | null = null;
function db() {
  dbp ??= openDB('ridebox', 1, {
    upgrade(d) {
      d.createObjectStore('workouts', { keyPath: 'id' });
      d.createObjectStore('rides', { keyPath: 'id' });
      d.createObjectStore('kv');
    },
  });
  return dbp;
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export async function loadSettings(): Promise<Settings> {
  try {
    const s = await (await db()).get('kv', 'settings');
    return { ...DEFAULT_SETTINGS, ...(s ?? {}) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}
export async function saveSettings(s: Settings) {
  await (await db()).put('kv', s, 'settings');
}

export async function listWorkouts(): Promise<StoredWorkout[]> {
  const all = (await (await db()).getAll('workouts')) as StoredWorkout[];
  return all.sort((a, b) => b.createdAt - a.createdAt);
}
export async function saveWorkout(w: StoredWorkout) {
  await (await db()).put('workouts', w);
}
export async function deleteWorkout(id: string) {
  await (await db()).delete('workouts', id);
}

export async function listRides(): Promise<RideRecord[]> {
  const all = (await (await db()).getAll('rides')) as RideRecord[];
  return all.sort((a, b) => b.startTime - a.startTime);
}
export async function saveRide(r: RideRecord) {
  await (await db()).put('rides', r);
}
export async function deleteRide(id: string) {
  await (await db()).delete('rides', id);
}

export async function getFlag(key: string): Promise<unknown> {
  return (await db()).get('kv', key);
}
export async function setFlag(key: string, value: unknown) {
  await (await db()).put('kv', value, key);
}
