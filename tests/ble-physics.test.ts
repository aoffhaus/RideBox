import { describe, expect, it } from 'vitest';
import {
  ftmsSimulation,
  ftmsTargetPower,
  parseCyclingPower,
  parseHeartRate,
  parseIndoorBikeData,
  wahooErg,
  wahooSimGrade,
} from '../src/ble/parse';
import { DEFAULT_RIDER, steadySpeed, stepSpeed } from '../src/physics/rider';
import { generateRoute, ROUTE_PRESETS } from '../src/world/route';
import { ArchTracker } from '../src/world/arches';
import { normalizedPower, summarize, type Sample } from '../src/app/recorder';
import { rideToFit } from '../src/export/fit';
import { Decoder, Stream } from '@garmin/fitsdk';

const dv = (bytes: number[]) => new DataView(new Uint8Array(bytes).buffer);

describe('BLE parsing', () => {
  it('FTMS indoor bike data: speed + cadence + power', () => {
    // flags 0x0044 = cadence(bit2) + power(bit6), bit0=0 → speed present
    // speed 3250 (32.50 km/h) = 0x0CB2, cadence 180 (90 rpm) = 0x00B4, power 250 = 0x00FA
    const d = parseIndoorBikeData(dv([0x44, 0x00, 0xb2, 0x0c, 0xb4, 0x00, 0xfa, 0x00]));
    expect(d).toEqual({ speed: 32.5, cadence: 90, power: 250 });
  });
  it('FTMS with distance + resistance before power, and HR', () => {
    // flags: cadence(0x04)|distance(0x10)|resistance(0x20)|power(0x40)|hr(0x200) = 0x0274
    const d = parseIndoorBikeData(dv([0x74, 0x02, 0x10, 0x27, 0xa0, 0x00, 0x01, 0x02, 0x03, 0x05, 0x00, 0x2c, 0x01, 0x8c]));
    expect(d.speed).toBe(100);
    expect(d.cadence).toBe(80);
    expect(d.power).toBe(300);
    expect(d.heartRate).toBe(140);
  });
  it('heart rate uint8 and uint16', () => {
    expect(parseHeartRate(dv([0x00, 142]))).toBe(142);
    expect(parseHeartRate(dv([0x01, 0x2c, 0x01]))).toBe(300);
  });
  it('cycling power with crank cadence', () => {
    // flags 0x20 crank data; power 200; revs 10, time 1024
    const a = parseCyclingPower(dv([0x20, 0x00, 0xc8, 0x00, 10, 0, 0x00, 0x04]), null, 0);
    expect(a.power).toBe(200);
    // +1.5 revs/s ... 3 revs in 2048/1024 = 2 s → 90 rpm
    const b = parseCyclingPower(dv([0x20, 0x00, 0xc8, 0x00, 13, 0, 0x00, 0x0c]), a.crank, 2000);
    expect(b.cadence).toBe(90);
  });
  it('encodes control commands', () => {
    expect([...ftmsTargetPower(250)]).toEqual([0x05, 0xfa, 0x00]);
    expect([...ftmsSimulation(0.05)]).toEqual([0x11, 0, 0, 0xf4, 0x01, 40, 51]);
    expect([...ftmsSimulation(-0.02)].slice(3, 5)).toEqual([0x38, 0xff]);
    expect([...wahooErg(300)]).toEqual([0x42, 0x2c, 0x01]);
    expect([...wahooSimGrade(0)]).toEqual([0x46, 0x00, 0x80]);
  });
});

describe('physics', () => {
  it('steady speeds are realistic', () => {
    const flat = steadySpeed(200, 0, DEFAULT_RIDER) * 3.6;
    expect(flat).toBeGreaterThan(30);
    expect(flat).toBeLessThan(36);
    const climb = steadySpeed(250, 0.07, DEFAULT_RIDER) * 3.6;
    expect(climb).toBeGreaterThan(10);
    expect(climb).toBeLessThan(15);
  });
  it('dynamic model converges to steady state', () => {
    let v = 0;
    for (let i = 0; i < 1200; i++) v = stepSpeed(v, 200, 0, 0.1, DEFAULT_RIDER);
    expect(v).toBeCloseTo(steadySpeed(200, 0, DEFAULT_RIDER), 1);
  });
});

describe('routes', () => {
  it('generates closed loops honoring max grade', () => {
    for (const p of ROUTE_PRESETS) {
      const r = generateRoute(p.id, 3);
      expect(Math.abs(r.length - p.lengthKm * 1000) / (p.lengthKm * 1000)).toBeLessThan(0.02);
      let maxG = 0;
      for (const g of r.grade) maxG = Math.max(maxG, Math.abs(g));
      expect(maxG).toBeLessThanOrEqual(p.maxGrade + 0.002);
      expect(maxG).toBeGreaterThan(p.maxGrade * 0.8);
      // loop closes
      const a = r.at(0);
      const b = r.at(r.length - 0.01);
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(10);
      expect(Math.abs(a.y - b.y)).toBeLessThan(1);
    }
  });
  it('is deterministic per seed', () => {
    expect(generateRoute('rolling', 5).at(1234)).toEqual(generateRoute('rolling', 5).at(1234));
  });
});

describe('arches', () => {
  it('rider reaches the arch when the interval ends (varying speed on hills)', () => {
    const route = generateRoute('rolling', 1);
    const arch = new ArchTracker();
    let v = 0;
    let d = 0;
    const intervalLen = 240;
    let maxErrAtEnd = 0;
    const dt = 1 / 30;
    let prevGap = Infinity;
    for (let t = 0; t <= intervalLen + 1e-9; t += dt) {
      const remaining = Math.max(0, intervalLen - t);
      v = stepSpeed(v, 230, route.at(d).grade, dt, DEFAULT_RIDER);
      d += v * dt;
      arch.update(dt, v);
      const gap = arch.archDistance(d, remaining) - d;
      // time-to-arch at current speed ≈ remaining (projection uses smoothed speed)
      if (remaining < 0.5) maxErrAtEnd = Math.max(maxErrAtEnd, gap / Math.max(v, 1));
      prevGap = gap;
    }
    expect(prevGap).toBeCloseTo(0, 5);
    expect(maxErrAtEnd).toBeLessThan(0.5); // arrives within 0.5 s of interval end
  });
});

describe('recording + FIT', () => {
  const mk = (n: number): Sample[] =>
    Array.from({ length: n }, (_, i) => ({
      t: Date.UTC(2026, 10, 18, 12, 0, i),
      elapsed: i,
      power: i < n / 2 ? 150 : 300,
      hr: 120 + Math.floor(i / 10),
      cadence: 90,
      speed: 9,
      distance: i * 9,
      altitude: 20 + Math.sin(i / 20) * 5,
      target: i < n / 2 ? 150 : 300,
    }));
  it('NP of constant power equals power', () => {
    expect(normalizedPower(new Array(100).fill(200))).toBeCloseTo(200);
  });
  it('writes a FIT file the official decoder reads back', () => {
    const samples = mk(120);
    const ride = {
      id: 'x',
      name: 'Test',
      routeName: 'Rolling Farmland',
      startTime: samples[0].t,
      ftp: 250,
      samples,
      laps: [
        { startIndex: 0, endIndex: 60, label: 'Easy' },
        { startIndex: 60, endIndex: 120, label: 'Hard' },
      ],
      summary: summarize(samples, 250),
    };
    const bytes = rideToFit(ride);
    const decoder = new Decoder(Stream.fromByteArray(bytes));
    expect(decoder.isFIT()).toBe(true);
    expect(decoder.checkIntegrity()).toBe(true);
    const { messages, errors } = decoder.read();
    expect(errors).toEqual([]);
    expect(messages.recordMesgs!.length).toBe(120);
    expect(messages.lapMesgs!.length).toBe(2);
    expect(messages.lapMesgs![1].avgPower).toBe(300);
    expect(messages.sessionMesgs![0].sport).toBe('cycling');
    expect(messages.sessionMesgs![0].subSport).toBe('virtualActivity');
    expect(messages.recordMesgs![10].heartRate).toBe(121);
    expect(messages.recordMesgs![10].power).toBe(150);
  });
});

describe('visual exaggeration', () => {
  it('scales elevation and grade for drawing only', async () => {
    const { exaggerateRoute } = await import('../src/world/route');
    const r = generateRoute('rolling', 2);
    const v = exaggerateRoute(r, 2);
    for (const d of [0, 1234.5, 5000, r.length - 1]) {
      const a = r.at(d);
      const b = v.at(d);
      expect(b.x).toBeCloseTo(a.x);
      expect(b.z).toBeCloseTo(a.z);
      expect(b.grade).toBeCloseTo(a.grade * 2, 5);
    }
    const min = Math.min(...r.y);
    expect(v.at(777).y - min).toBeCloseTo((r.at(777).y - min) * 2, 3);
    expect(v.base).toBe(r);
    expect(exaggerateRoute(r, 1)).toBe(r);
  });
});
