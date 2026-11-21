// Crash recovery for a ride in progress. The draft lives in the local-only `meta`
// store (never synced) and is cleared when the ride is finished or discarded.

import { db } from '../storage/db';
import type { RideRecord } from './recorder';

const KEY = 'ride-draft';
/** Drafts shorter than this many seconds aren't worth recovering. */
export const MIN_DRAFT_SAMPLES = 30;

export async function saveDraft(r: RideRecord): Promise<void> {
  if (r.samples.length < MIN_DRAFT_SAMPLES) return;
  await (await db()).put('meta', r, KEY);
}

export async function loadDraft(): Promise<RideRecord | undefined> {
  const r = (await (await db()).get('meta', KEY)) as RideRecord | undefined;
  return r && r.samples?.length >= MIN_DRAFT_SAMPLES ? r : undefined;
}

export async function clearDraft(): Promise<void> {
  await (await db()).delete('meta', KEY);
}
