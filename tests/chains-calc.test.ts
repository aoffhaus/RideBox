// Ported from tests/test_calc.py in the Python app.
import { describe, expect, it } from "vitest";
import {
  applyDefaultGear,
  assignRides,
  bikeLubeStatus,
  bikeStatus,
  chainLubeStatus,
  chainOnBikeAt,
  chainStats,
  currentLink,
  estimatedTimeS,
  indoorOutdoor,
  linkUses,
  METERS_PER_MILE,
  periodUsage,
  usage,
  type Chain,
  type Install,
  type Lube,
  type QuickLink,
  type Ride,
} from "../src/chains/calc";

const BIKE = "b100";
const OTHER_BIKE = "b200";

const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

let nextId = 1;
function ride(start: number, opts: { km?: number; gear?: string | null; minutes?: number; type?: string; trainer?: boolean } = {}): Ride {
  return {
    activity_id: nextId++,
    gear_id: opts.gear === undefined ? BIKE : opts.gear,
    start,
    distance_m: (opts.km ?? 10) * 1000,
    moving_time_s: (opts.minutes ?? 30) * 60,
    type: opts.type ?? "",
    trainer: opts.trainer ?? false,
  };
}

const install = (id: string, chain: string, at: number, bike = BIKE, link_id = ""): Install => ({
  install_id: id,
  bike_id: bike,
  chain_id: chain,
  installed_at: at,
  note: "",
  link_id,
});

const chain = (id: string, name: string, start_distance_m = 0): Chain => ({
  chain_id: id,
  name,
  notes: "",
  retired: false,
  created_at: null,
  start_distance_m,
});

const CHAINS = [chain("A", "Chain A"), chain("B", "Chain B")];

const lube = (id: string, at: number, bike = BIKE, chainId = ""): Lube => ({
  lube_id: id,
  bike_id: bike,
  chain_id: chainId,
  lubed_at: at,
  note: "",
});

describe("chain stats", () => {
  it("counts multiple rides on swap day after the swap to the new chain", () => {
    const installs = [install("i1", "A", utc(2026, 5, 1)), install("i2", "B", utc(2026, 6, 1, 6))];
    const rides = [ride(utc(2026, 6, 1, 7)), ride(utc(2026, 6, 1, 12)), ride(utc(2026, 6, 1, 18))];
    const s = chainStats(CHAINS, installs, rides);
    expect(s.get("A")!.ridden.distance_m).toBe(0);
    expect(s.get("B")!.ridden.distance_m).toBe(30_000);
    expect(s.get("B")!.since_install!.distance_m).toBe(30_000);
  });

  it("splits two same-day rides around a swap", () => {
    const installs = [install("i1", "A", utc(2026, 5, 1)), install("i2", "B", utc(2026, 6, 1, 12))];
    const s = chainStats(CHAINS, installs, [ride(utc(2026, 6, 1, 8), { km: 20 }), ride(utc(2026, 6, 1, 17), { km: 5 })]);
    expect(s.get("A")!.ridden.distance_m).toBe(20_000);
    expect(s.get("B")!.ridden.distance_m).toBe(5_000);
    expect(s.get("A")!.since_install).toBeNull();
    expect(s.get("A")!.current_bike_id).toBeNull();
    expect(s.get("B")!.current_bike_id).toBe(BIKE);
  });

  it("gives a ride starting exactly at the swap to the new chain", () => {
    const installs = [install("i1", "A", utc(2026, 5, 1)), install("i2", "B", utc(2026, 6, 1, 12))];
    const s = chainStats(CHAINS, installs, [ride(utc(2026, 6, 1, 12))]);
    expect(s.get("A")!.ridden.distance_m).toBe(0);
    expect(s.get("B")!.ridden.distance_m).toBe(10_000);
  });

  it("ignores rides with no gear id", () => {
    const installs = [install("i1", "A", utc(2026, 5, 1))];
    const rides = [ride(utc(2026, 5, 2), { gear: null }), ride(utc(2026, 5, 3), { gear: "" }), ride(utc(2026, 5, 4))];
    expect(chainStats(CHAINS, installs, rides).get("A")!.ridden.distance_m).toBe(10_000);
    expect(bikeStatus([BIKE], installs, rides).get(BIKE)!.unassigned).toEqual([]);
  });

  it("doesn't count rides on other gear", () => {
    const installs = [install("i1", "A", utc(2026, 5, 1))];
    const rides = [ride(utc(2026, 5, 2), { gear: OTHER_BIKE }), ride(utc(2026, 5, 2), { gear: "g999" })];
    expect(chainStats(CHAINS, installs, rides).get("A")!.ridden.distance_m).toBe(0);
  });

  it("handles a chain swapped off and on several times", () => {
    const installs = [
      install("i1", "A", utc(2026, 1, 1)),
      install("i2", "B", utc(2026, 2, 1)),
      install("i3", "A", utc(2026, 3, 1)),
      install("i4", "B", utc(2026, 4, 1)),
      install("i5", "A", utc(2026, 5, 1)),
    ];
    const rides = [
      ride(utc(2026, 1, 15), { km: 10, minutes: 20 }),
      ride(utc(2026, 2, 15), { km: 20, minutes: 40 }),
      ride(utc(2026, 3, 15), { km: 30, minutes: 60 }),
      ride(utc(2026, 4, 15), { km: 40, minutes: 80 }),
      ride(utc(2026, 5, 15), { km: 50, minutes: 100 }),
      ride(utc(2026, 5, 20), { km: 5, minutes: 10 }),
    ];
    const s = chainStats(CHAINS, installs, rides);
    const a = s.get("A")!;
    const b = s.get("B")!;
    expect(a.periods.length).toBe(3);
    expect(b.periods.length).toBe(2);
    expect(a.ridden.distance_m).toBe(95_000);
    expect(a.ridden.moving_time_s).toBe(190 * 60);
    expect(b.ridden.distance_m).toBe(60_000);
    expect(a.since_install!.distance_m).toBe(55_000);
    expect(a.since_install!.moving_time_s).toBe(110 * 60);
    expect(b.since_install).toBeNull();
    expect(a.periods.map((p) => periodUsage(p).distance_m)).toEqual([10_000, 30_000, 55_000]);
    expect(a.periods.map((p) => p.end)).toEqual([utc(2026, 2, 1), utc(2026, 4, 1), null]);
  });

  it("leaves rides before the first install unassigned", () => {
    const installs = [install("i1", "A", utc(2026, 5, 1))];
    const rides = [ride(utc(2026, 4, 1), { km: 7 }), ride(utc(2026, 4, 30, 23), { km: 3 }), ride(utc(2026, 5, 2), { km: 10 })];
    const st = bikeStatus([BIKE], installs, rides).get(BIKE)!;
    expect(usage(st.unassigned).distance_m).toBe(10_000);
    expect(periodUsage(st.current!).distance_m).toBe(10_000);
    expect(chainStats(CHAINS, installs, rides).get("A")!.ridden.distance_m).toBe(10_000);
  });

  it("leaves all rides unassigned on a bike without installs", () => {
    const installs = [install("i1", "A", utc(2026, 5, 1))];
    const st = bikeStatus([BIKE, OTHER_BIKE], installs, [ride(utc(2026, 5, 2), { gear: OTHER_BIKE })]).get(OTHER_BIKE)!;
    expect(st.current).toBeNull();
    expect(usage(st.unassigned).distance_m).toBe(10_000);
  });

  it("keeps installs per bike", () => {
    const installs = [install("i1", "A", utc(2026, 5, 1), BIKE), install("i2", "B", utc(2026, 5, 10), OTHER_BIKE)];
    const rides = [ride(utc(2026, 5, 15)), ride(utc(2026, 5, 15), { gear: OTHER_BIKE, km: 4 })];
    const s = chainStats(CHAINS, installs, rides);
    expect(s.get("A")!.since_install!.distance_m).toBe(10_000);
    expect(s.get("B")!.since_install!.distance_m).toBe(4_000);
  });

  it("doesn't depend on install order", () => {
    const installs = [install("i2", "B", utc(2026, 6, 1)), install("i1", "A", utc(2026, 5, 1))];
    const { periods } = assignRides(installs, [ride(utc(2026, 5, 15))]);
    expect(periods.map((p) => p.install.chain_id)).toEqual(["A", "B"]);
    expect(periodUsage(periods[0]).distance_m).toBe(10_000);
  });

  it("adds starting miles to lifetime with estimated time", () => {
    const startM = 160 * METERS_PER_MILE;
    const s = chainStats([chain("A", "Chain A", startM)], [install("i1", "A", utc(2026, 5, 1))], [
      ride(utc(2026, 5, 2), { km: 10, minutes: 30 }),
    ]).get("A")!;
    expect(s.start_time_estimated_s).toBeCloseTo(10 * 3600);
    expect(s.lifetime_distance_m).toBeCloseTo(startM + 10_000);
    expect(s.lifetime_time_s).toBeCloseTo(10 * 3600 + 1800);
    expect(s.since_install!.distance_m).toBe(10_000);
  });

  it("estimates zero time for no distance", () => {
    expect(estimatedTimeS(0)).toBe(0);
  });

  it("gives a never-installed chain empty stats", () => {
    const s = chainStats(CHAINS, [], [ride(utc(2026, 5, 2))]).get("A")!;
    expect(s.periods.length).toBe(0);
    expect(s.lifetime_distance_m).toBe(0);
    expect(s.current_bike_id).toBeNull();
  });
});

describe("default gear", () => {
  it("assigns untagged virtual rides to the default bike", () => {
    const installs = [install("i1", "A", utc(2026, 5, 1))];
    const virtual = ride(utc(2026, 5, 2), { gear: null, km: 20, type: "VirtualRide" });
    const taggedElsewhere = ride(utc(2026, 5, 3), { gear: OTHER_BIKE, km: 5, type: "VirtualRide" });
    const outdoorUntagged = ride(utc(2026, 5, 4), { gear: null, km: 7, type: "Ride" });
    const rides = applyDefaultGear([virtual, taggedElsewhere, outdoorUntagged], { VirtualRide: BIKE });
    expect(chainStats(CHAINS, installs, rides).get("A")!.ridden.distance_m).toBe(20_000);
    expect(applyDefaultGear([virtual], {})).toEqual([virtual]);
  });
});

describe("lubes", () => {
  it("counts only that chain's rides after the lube", () => {
    const installs = [install("i1", "A", utc(2026, 5, 1)), install("i2", "B", utc(2026, 6, 1))];
    const rides = [ride(utc(2026, 5, 5), { km: 10 }), ride(utc(2026, 5, 15), { km: 20 }), ride(utc(2026, 6, 5), { km: 40 })];
    const lubes = [lube("l1", utc(2026, 5, 10), BIKE, "A")];
    const s = chainLubeStatus("A", lubes, installs, rides);
    expect(s.lube!.lube_id).toBe("l1");
    expect(usage(s.rides).distance_m).toBe(20_000);
    expect(chainLubeStatus("B", lubes, installs, rides).lube).toBeNull();
  });

  it("follows the chain off and back on", () => {
    const installs = [install("i1", "A", utc(2026, 5, 1)), install("i2", "B", utc(2026, 5, 20)), install("i3", "A", utc(2026, 6, 1))];
    const rides = [ride(utc(2026, 5, 15), { km: 10 }), ride(utc(2026, 5, 25), { km: 30 }), ride(utc(2026, 6, 5), { km: 5 })];
    const lubes = [lube("l1", utc(2026, 5, 2), BIKE, "A"), lube("l0", utc(2026, 5, 1), BIKE, "A")];
    const s = chainLubeStatus("A", lubes, installs, rides);
    expect(s.lube!.lube_id).toBe("l1");
    expect(usage(s.rides).distance_m).toBe(15_000);
  });

  it("finds the chain on a bike at a moment", () => {
    const installs = [install("i1", "A", utc(2026, 5, 1)), install("i2", "B", utc(2026, 6, 1))];
    expect(chainOnBikeAt(installs, BIKE, utc(2026, 4, 1))).toBeNull();
    expect(chainOnBikeAt(installs, BIKE, utc(2026, 5, 15))).toBe("A");
    expect(chainOnBikeAt(installs, BIKE, utc(2026, 6, 1))).toBe("B");
    expect(chainOnBikeAt(installs, OTHER_BIKE, utc(2026, 6, 1))).toBeNull();
  });

  it("counts a bike's rides after its lube", () => {
    const rides = [
      ride(utc(2026, 5, 1), { km: 10, gear: OTHER_BIKE }),
      ride(utc(2026, 5, 10), { km: 20, gear: OTHER_BIKE, minutes: 60 }),
      ride(utc(2026, 5, 10), { km: 99 }),
    ];
    const lubes = [lube("l1", utc(2026, 5, 5), OTHER_BIKE)];
    const u = usage(bikeLubeStatus(OTHER_BIKE, lubes, rides).rides);
    expect(u.distance_m).toBe(20_000);
    expect(u.moving_time_s).toBe(3600);
    expect(bikeLubeStatus(BIKE, lubes, rides).lube).toBeNull();
  });
});

describe("indoor/outdoor and quick links", () => {
  it("splits indoor and outdoor", () => {
    const rides = [
      ride(utc(2026, 5, 1), { km: 20, minutes: 60, type: "VirtualRide" }),
      ride(utc(2026, 5, 2), { km: 15, minutes: 30, type: "Ride", trainer: true }),
      ride(utc(2026, 5, 3), { km: 50, minutes: 120, type: "Ride" }),
      ride(utc(2026, 5, 4), { km: 30, minutes: 90, type: "GravelRide" }),
    ];
    const { indoor, outdoor } = indoorOutdoor(rides);
    expect(indoor).toEqual({ distance_m: 35_000, moving_time_s: 90 * 60, rides: 2 });
    expect(outdoor).toEqual({ distance_m: 80_000, moving_time_s: 210 * 60, rides: 2 });
    const empty = { distance_m: 0, moving_time_s: 0, rides: 0 };
    expect(indoorOutdoor([])).toEqual({ indoor: empty, outdoor: empty });
  });

  it("tallies quick link uses and finds the current link", () => {
    const link = (id: string, c: string, at: number, start_uses = 0): QuickLink => ({ link_id: id, chain_id: c, added_at: at, start_uses, note: "" });
    const old = link("q1", "A", utc(2026, 1, 1), 2);
    const nw = link("q2", "A", utc(2026, 5, 1));
    const other = link("q3", "B", utc(2026, 6, 1));
    const installs = [
      install("i1", "A", utc(2026, 2, 1), BIKE, "q1"),
      install("i2", "B", utc(2026, 3, 1), BIKE, "q3"),
      install("i3", "A", utc(2026, 4, 1), BIKE, "q1"),
      install("i4", "A", utc(2026, 5, 1), BIKE, "q2"),
      install("i5", "A", utc(2026, 6, 1)),
    ];
    expect(linkUses(old, installs)).toBe(4);
    expect(linkUses(nw, installs)).toBe(1);
    expect(currentLink("A", [old, nw, other])).toBe(nw);
    expect(currentLink("C", [old, nw, other])).toBeNull();
  });
});
