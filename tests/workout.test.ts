import { describe, expect, it } from 'vitest';
import { flatten, parseDuration, plannedStats, totalDuration } from '../src/workout/model';
import { parseWorkout, parseZwo, toZwo, toRideBoxJson, parseRideBoxJson, parseText, parseTrainerRoadJson } from '../src/workout/parsers';
import { WorkoutEngine } from '../src/workout/engine';

const ZWO = `<?xml version="1.0"?>
<workout_file>
  <author>Coach</author>
  <name>Sweet &amp; Spot</name>
  <description>3x10</description>
  <sportType>bike</sportType>
  <workout>
    <Warmup Duration="600" PowerLow="0.45" PowerHigh="0.70"/>
    <IntervalsT Repeat="3" OnDuration="600" OffDuration="300" OnPower="0.90" OffPower="0.50" Cadence="90"/>
    <SteadyState Duration="120" Power="1.05">
      <textevent timeoffset="10" message="Stay smooth"/>
    </SteadyState>
    <FreeRide Duration="60"/>
    <Cooldown Duration="300" PowerLow="0.60" PowerHigh="0.40"/>
  </workout>
</workout_file>`;

describe('durations', () => {
  it('parses many formats', () => {
    expect(parseDuration('10m')).toBe(600);
    expect(parseDuration('1h5m')).toBe(3900);
    expect(parseDuration('1m30s')).toBe(90);
    expect(parseDuration('8:00')).toBe(480);
    expect(parseDuration('1:02:30')).toBe(3750);
    expect(parseDuration(45)).toBe(45);
    expect(parseDuration('45')).toBe(45);
  });
});

describe('zwo', () => {
  it('parses all element types', () => {
    const w = parseZwo(ZWO);
    expect(w.name).toBe('Sweet & Spot');
    const iv = flatten(w);
    expect(iv.length).toBe(1 + 6 + 1 + 1 + 1);
    expect(iv[0]).toMatchObject({ duration: 600, powerStart: 0.45, powerEnd: 0.7 });
    expect(iv[1]).toMatchObject({ duration: 600, powerStart: 0.9, cadence: 90 });
    expect(iv[2]).toMatchObject({ duration: 300, powerStart: 0.5 });
    expect(iv[7].cues[0]).toMatchObject({ offset: 10, message: 'Stay smooth' });
    expect(iv[8].free).toBe(true);
    expect(iv[9]).toMatchObject({ powerStart: 0.6, powerEnd: 0.4 });
    expect(totalDuration(iv)).toBe(600 + 3 * 900 + 120 + 60 + 300);
  });
  it('round-trips through export', () => {
    const w = parseZwo(ZWO);
    const again = parseZwo(toZwo(w, 250));
    expect(totalDuration(flatten(again))).toBe(totalDuration(flatten(w)));
  });
});

describe('erg / mrc', () => {
  it('parses .mrc percent files', () => {
    const mrc = `[COURSE HEADER]
VERSION = 2
UNITS = ENGLISH
DESCRIPTION = Test
FILE NAME = Baxter
MINUTES PERCENT
[END COURSE HEADER]
[COURSE DATA]
0.00\t50
5.00\t50
5.00\t95
15.00\t95
15.00\t50
20.00\t70
[END COURSE DATA]
[COURSE TEXT]
330\tHold it\t10
[END COURSE TEXT]`;
    const w = parseWorkout(mrc, 'baxter.mrc');
    expect(w.name).toBe('Baxter');
    const iv = flatten(w);
    expect(iv.map((i) => i.duration)).toEqual([300, 600, 300]);
    expect(iv[1].powerStart).toBeCloseTo(0.95);
    expect(iv[1].cues[0]).toMatchObject({ offset: 30, message: 'Hold it' });
    expect(iv[2]).toMatchObject({ powerStart: 0.5, powerEnd: 0.7 });
  });
  it('parses .erg watts files', () => {
    const erg = `[COURSE HEADER]\nMINUTES WATTS\n[END COURSE HEADER]\n[COURSE DATA]\n0\t100\n1\t100\n1\t300\n2\t300\n[END COURSE DATA]`;
    const iv = flatten(parseWorkout(erg, 'x.erg'));
    expect(iv[1]).toMatchObject({ unit: 'watts', powerStart: 300, duration: 60 });
  });
});

describe('json', () => {
  it('parses the RideBox format and round-trips', () => {
    const src = {
      name: 'Claude VO2',
      steps: [
        { type: 'ramp', duration: '10m', from: 45, to: 70 },
        { type: 'repeat', count: 5, steps: [{ type: 'steady', duration: '3m', power: 120, cues: [{ at: 0, text: 'Go!' }] }, { type: 'steady', duration: '3m', power: 50 }] },
        { type: 'steady', duration: 300, watts: 150 },
        { type: 'free', duration: '5m' },
      ],
    };
    const w = parseRideBoxJson(JSON.stringify(src));
    const iv = flatten(w);
    expect(iv.length).toBe(1 + 10 + 1 + 1);
    expect(iv[1].powerStart).toBeCloseTo(1.2);
    expect(iv[11]).toMatchObject({ unit: 'watts', powerStart: 150 });
    const again = parseRideBoxJson(toRideBoxJson(w));
    expect(flatten(again)).toEqual(iv);
  });
  it('accepts fenced paste from chat', () => {
    const w = parseWorkout('```json\n{"name":"X","steps":[{"type":"steady","duration":"1m","power":60}]}\n```');
    expect(w.name).toBe('X');
  });
  it('gives helpful errors', () => {
    expect(() => parseRideBoxJson('{"steps":[{"type":"steady","power":50}]}')).toThrow(/duration/);
  });
});

describe('text shorthand', () => {
  it('parses inline repeats, ramps, watts, cadence, free', () => {
    const w = parseText('# Over-unders\n10m 45-70%\n3x(8m @105% 95rpm, 4m @50%)\n5m @150w\n2x 30s @150%\n5m free\n10m 60-40%');
    expect(w.name).toBe('Over-unders');
    const iv = flatten(w);
    expect(iv.length).toBe(1 + 6 + 1 + 2 + 1 + 1);
    expect(iv[1]).toMatchObject({ duration: 480, cadence: 95 });
    expect(iv[1].powerStart).toBeCloseTo(1.05);
    expect(iv[7]).toMatchObject({ unit: 'watts', powerStart: 150 });
    expect(iv[8].duration).toBe(30);
    expect(iv[10].free).toBe(true);
  });
  it('parses multi-line repeat blocks', () => {
    const iv = flatten(parseText('4x\n5m @110%\n5m @50%\nend\n5m @50%'));
    expect(iv.length).toBe(9);
  });
  it('comma separated single line', () => {
    const iv = flatten(parseText('10m @55%, 3x(8m @105%, 4m @50%), 10m @50%'));
    expect(iv.length).toBe(8);
  });
});

describe('trainerroad json', () => {
  it('rebuilds steps from a second-by-second series', () => {
    // Real TR shape: Seconds in ms, only the value after a jump is recorded
    const data: { Seconds: number; FtpPercent: number }[] = [];
    let t = 0;
    for (let i = 0; i < 300; i++) data.push({ Seconds: (t++) * 1000, FtpPercent: 50 + (25 * i) / 300 }); // ramp 50→75
    for (let i = 0; i < 600; i++) data.push({ Seconds: (t++) * 1000, FtpPercent: 95 });
    for (let i = 0; i < 300; i++) data.push({ Seconds: (t++) * 1000, FtpPercent: 55 });
    const raw = { Workout: { Details: { WorkoutName: 'Antelope', WorkoutDescription: '<p>Sweet spot</p>' }, WorkoutData: data, intervalData: [{ Name: 'Fake' }] } };
    const w = parseTrainerRoadJson(raw);
    expect(w.name).toBe('Antelope');
    expect(w.description).toBe('Sweet spot');
    const iv = flatten(w);
    expect(iv.map((x) => x.duration)).toEqual([300, 600, 300]);
    expect(iv[0].powerStart).toBeCloseTo(0.5, 2);
    expect(iv[0].powerEnd).toBeCloseTo(0.75, 2);
    expect(iv[1].powerStart).toBeCloseTo(0.95);
    // auto-detected by parseWorkout
    expect(flatten(parseWorkout(JSON.stringify(raw), 'tr.json')).length).toBe(3);
  });
});

describe('engine', () => {
  const w = parseText('2m @50%\n1m 50-100%\n2m @100%');
  it('tracks intervals, ramps and targets', () => {
    const e = new WorkoutEngine(w, 200);
    expect(e.state.targetWatts).toBe(100);
    e.tick(150);
    expect(e.state.index).toBe(1);
    expect(e.state.targetWatts).toBe(150);
    expect(e.state.remaining).toBeCloseTo(30);
    e.tick(1000);
    expect(e.state.finished).toBe(true);
    expect(e.state.targetWatts).toBeNull();
  });
  it('intensity changes in 1% steps', () => {
    const e = new WorkoutEngine(w, 200);
    e.adjustIntensity(1);
    e.adjustIntensity(1);
    e.adjustIntensity(1);
    expect(e.state.intensity).toBe(103);
    expect(e.state.targetWatts).toBe(103);
    e.adjustIntensity(-5);
    expect(e.state.targetWatts).toBe(98);
  });
  it('skip and extend shift the timeline', () => {
    const e = new WorkoutEngine(w, 200);
    e.tick(30);
    e.skip();
    expect(e.state.index).toBe(1);
    expect(e.duration).toBe(30 + 60 + 120);
    e.tick(60); // now in last interval
    e.extend(60);
    expect(e.state.remaining).toBeCloseTo(180);
    expect(e.duration).toBe(270);
  });
  it('pause stops the clock', () => {
    const e = new WorkoutEngine(w, 200);
    e.setPaused(true);
    e.tick(10);
    expect(e.elapsed).toBe(0);
  });
  it('planned stats are sane', () => {
    const s = plannedStats(flatten(parseText('60m @100%')), 250);
    expect(s.tss).toBeCloseTo(100, 0);
    expect(s.if).toBeCloseTo(1);
  });
});
