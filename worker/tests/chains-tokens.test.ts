import { describe, expect, it } from 'vitest';
import { sharedTokens } from '../chains';
import type { AuthStore, StravaAuth } from '../strava';

function memStore(a: StravaAuth | null): AuthStore & { value: StravaAuth | null } {
  return {
    value: a,
    async get() {
      return this.value;
    },
    async put(v) {
      this.value = v;
    },
    async clear() {
      this.value = null;
    },
  };
}

describe('chain tracker uses RideBox’s Strava sign-in', () => {
  it('loads nothing when Strava isn’t connected', async () => {
    expect(await sharedTokens(memStore(null)).load()).toBeNull();
  });

  it('saves refreshed tokens without losing the athlete or scope', async () => {
    const store = memStore({ access_token: 'A', refresh_token: 'R', expires_at: 1, athlete_name: 'Pat', scope: 'activity:read_all,profile:read_all' });
    const t = sharedTokens(store);
    expect(await t.load()).toEqual({ access_token: 'A', refresh_token: 'R', expires_at: 1 });
    await t.save({ access_token: 'A2', refresh_token: 'R2', expires_at: 2 });
    expect(store.value).toEqual({ access_token: 'A2', refresh_token: 'R2', expires_at: 2, athlete_name: 'Pat', scope: 'activity:read_all,profile:read_all' });
  });

  it('does not recreate a sign-in that was disconnected mid-sync', async () => {
    const store = memStore(null);
    await sharedTokens(store).save({ access_token: 'A', refresh_token: 'R', expires_at: 2 });
    expect(store.value).toBeNull();
  });
});
