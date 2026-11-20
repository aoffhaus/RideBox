// Ported from tests/test_sync.py, plus cases for stepped pulls.
import { describe, expect, it } from "vitest";
import { RateLimited, type StravaActivity, type StravaApi } from "../worker/chains/strava";
import { syncStep, toIso, type CachedRide, type SyncStore } from "../worker/chains/sync";

const NOW = new Date(Date.UTC(2026, 9, 26, 18, 0));
const days = (n: number) => n * 24 * 3600 * 1000;
const ago = (n: number) => new Date(NOW.getTime() - days(n));

class MemStore implements SyncStore {
  meta = new Map<string, string>();
  bikes: { bike_id: string; name: string }[] = [];
  installs: string[] = [];
  rides = new Map<number, CachedRide & { pull_id: string }>();

  async getMeta(k: string) {
    return this.meta.get(k) ?? null;
  }
  async setMeta(values: Record<string, string | null>) {
    for (const [k, v] of Object.entries(values)) v === null ? this.meta.delete(k) : this.meta.set(k, v);
  }
  async upsertBikes(b: { bike_id: string; name: string }[]) {
    this.bikes = b;
  }
  async earliestInstall() {
    return this.installs.length ? [...this.installs].sort()[0] : null;
  }
  async upsertRides(rides: CachedRide[], pullId: string) {
    for (const r of rides) this.rides.set(r.activity_id, { ...r, pull_id: pullId });
  }
  async deleteStaleRides(windowStart: string, pullId: string) {
    let n = 0;
    for (const [id, r] of this.rides) {
      if (r.start_date >= windowStart && r.pull_id !== pullId) {
        this.rides.delete(id);
        n++;
      }
    }
    return n;
  }
  ids() {
    return [...this.rides.keys()].sort((a, b) => a - b);
  }
}

const act = (id: number, start: Date, gear = "b1"): StravaActivity => ({
  id,
  gear_id: gear,
  start_date: toIso(start),
  distance: 10_000,
  moving_time: 1800,
  name: `Ride ${id}`,
  sport_type: "Ride",
});

class FakeClient implements StravaApi {
  afters: Date[] = [];
  pages: number[] = [];
  constructor(
    public activities: StravaActivity[],
    public opts: { rateLimit?: boolean; perPage?: number } = {},
  ) {}
  async bikes() {
    return [{ bike_id: "b1", name: "Road bike" }];
  }
  async activitiesPage(after: Date, page: number) {
    if (this.opts.rateLimit) throw new RateLimited(new Date(NOW.getTime() + 15 * 60_000), "Strava rate limit reached.");
    this.afters.push(after);
    this.pages.push(page);
    const per = this.opts.perPage ?? 200;
    const matching = this.activities
      .filter((a) => new Date(a.start_date) > after)
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
    return matching.slice((page - 1) * per, page * per);
  }
}

function setup() {
  const store = new MemStore();
  store.installs.push(toIso(ago(90)));
  return store;
}

describe("syncStep", () => {
  it("first sync pulls from the earliest install and saves bikes", async () => {
    const store = setup();
    const client = new FakeClient([act(1, ago(100)), act(2, ago(60))]);
    const r = await syncStep(store, client, { now: NOW });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("Full pull");
    expect(client.afters[0].getTime()).toBeLessThan(ago(90).getTime());
    expect(store.bikes).toEqual([{ bike_id: "b1", name: "Road bike" }]);
    // The 100-day-old ride is outside the 1-day pad before the earliest install.
    expect(store.ids()).toEqual([2]);
  });

  it("incremental sync re-pulls 30 days and drops deleted rides", async () => {
    const store = setup();
    const old = act(1, ago(60));
    await syncStep(store, new FakeClient([old, act(2, ago(5))]), { now: NOW });

    const later = new Date(NOW.getTime() + 3600_000);
    const client = new FakeClient([old, act(3, ago(2), "b2")]); // ride 2 deleted on Strava
    expect((await syncStep(store, client, { now: later })).ok).toBe(true);
    expect(client.afters[0].getTime()).toBeLessThan(ago(29).getTime());
    expect(client.afters[0].getTime()).toBeGreaterThan(ago(31).getTime());
    expect(store.ids()).toEqual([1, 3]);
  });

  it("an earlier install triggers a full pull", async () => {
    const store = setup();
    await syncStep(store, new FakeClient([]), { now: NOW });
    store.installs.push(toIso(ago(200)));
    const r = await syncStep(store, new FakeClient([act(9, ago(150))]), { now: new Date(NOW.getTime() + 3600_000) });
    expect(r.message).toContain("Full pull");
    expect(store.ids()).toEqual([9]);
  });

  it("rate limit sets a backoff and later calls skip", async () => {
    const store = setup();
    const r = await syncStep(store, new FakeClient([], { rateLimit: true }), { now: NOW });
    expect(r.ok).toBe(false);
    const again = await syncStep(store, new FakeClient([]), { now: new Date(NOW.getTime() + 5 * 60_000), force: true });
    expect(again.ok).toBe(false);
    expect(again.message).toContain("paused");
  });

  it("skips when not due unless forced", async () => {
    const store = setup();
    await syncStep(store, new FakeClient([]), { now: NOW });
    const soon = new Date(NOW.getTime() + 5 * 60_000);
    const client = new FakeClient([act(5, ago(1))]);
    expect((await syncStep(store, client, { now: soon })).message).toBe("Already up to date.");
    expect(client.afters).toEqual([]);
    await syncStep(store, client, { now: soon, force: true });
    expect(store.ids()).toEqual([5]);
  });

  it("with no installs only updates bikes", async () => {
    const store = new MemStore();
    const r = await syncStep(store, new FakeClient([act(1, ago(1))]), { now: NOW });
    expect(r.message).toContain("No installs");
    expect(store.bikes.length).toBe(1);
    expect(store.ids()).toEqual([]);
  });

  it("splits a long pull into steps and resumes where it stopped", async () => {
    const store = setup();
    const acts = Array.from({ length: 25 }, (_, i) => act(i + 1, ago(80 - i)));
    const client = new FakeClient(acts, { perPage: 200 });
    // Shrink pages: 25 rides at 200/page would be one page, so fake 10/page via a wrapper.
    const small: StravaApi = {
      bikes: () => client.bikes(),
      activitiesPage: async (after, page) => {
        const all = await client.activitiesPage(after, 1);
        const chunk = all.slice((page - 1) * 10, page * 10);
        // Report a full page (200) while more remain, as Strava would.
        return page * 10 < all.length ? [...chunk, ...Array(190).fill(null).map((_, j) => act(10_000 + page * 1000 + j, ago(200)))] : chunk;
      },
    };
    const first = await syncStep(store, small, { now: NOW, maxPages: 1 });
    expect(first.more).toBe(true);
    expect(store.meta.get("pull_page")).toBe("2");
    const second = await syncStep(store, small, { now: NOW, maxPages: 1 });
    expect(second.more).toBe(true);
    const third = await syncStep(store, small, { now: NOW, maxPages: 1 });
    expect(third.more).toBe(false);
    expect(third.message).toContain("Full pull");
    expect(store.ids()).toEqual(acts.map((a) => a.id)); // padding rides were outside the window
    expect(store.meta.has("pull_id")).toBe(false);
  });

  it("keeps old rides visible until a pull finishes, then drops unseen ones", async () => {
    const store = setup();
    await syncStep(store, new FakeClient([act(1, ago(10)), act(2, ago(5))]), { now: NOW });
    // Start a new pull that stops partway (rate limited on page 2).
    let calls = 0;
    const flaky: StravaApi = {
      bikes: async () => [{ bike_id: "b1", name: "Road bike" }],
      activitiesPage: async () => {
        calls++;
        if (calls === 1) return [act(1, ago(10)), ...Array(199).fill(null).map((_, j) => act(500 + j, ago(300)))];
        throw new RateLimited(new Date(NOW.getTime() + 3600_000 + 15 * 60_000), "Strava rate limit reached.");
      },
    };
    const later = new Date(NOW.getTime() + 3600_000);
    expect((await syncStep(store, flaky, { now: later })).ok).toBe(false);
    expect(store.ids()).toEqual([1, 2]); // ride 2 not seen yet, still shown
    const after = new Date(later.getTime() + 20 * 60_000);
    await syncStep(store, new FakeClient([act(1, ago(10))]), { now: after });
    expect(store.ids()).toEqual([1]);
  });
});
