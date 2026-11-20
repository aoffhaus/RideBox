import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/storage/db';
import { adaptSuggestion, buildContext, planFromOutput, readEvents, resolveChoice, reviewAdaptation, todayOptions } from '../src/training/coach';
import { SCHEMAS, type CoachWorkout, type PlanInput, type PlanOutput } from '../src/training/coachSchema';
import type { PlannedWorkout } from '../src/training/model';
import { BUILTIN_WORKOUTS } from '../src/workout/builtin';

const lib = BUILTIN_WORKOUTS;
const claudeWorkout: CoachWorkout = {
  name: 'Threshold 3x10',
  description: 'Three threshold efforts.',
  text: '10m 45-70%\n3x(10m @98% "Threshold", 5m @50%)\n5m 60-40%',
};
const NONE: CoachWorkout = { name: '', description: '', text: '' };
const lib_ = (name: string) => ({ library_name: name, workout: NONE });
const own = (w: CoachWorkout) => ({ library_name: '', workout: w });
const pw = (id: string, date: string, status: PlannedWorkout['status'] = 'planned'): PlannedWorkout => ({ id, date, workout: lib[0], status, origin: 'plan', createdAt: 0 });

describe('resolveChoice', () => {
  it('uses library workouts by name (case-insensitive) and parses new ones', () => {
    expect(resolveChoice(lib_('sweet spot 3x12'), lib).name).toBe('Sweet Spot 3x12');
    const w = resolveChoice(own(claudeWorkout), lib);
    expect(w.name).toBe('Threshold 3x10');
    expect(w.description).toBe('Three threshold efforts.');
    expect(w.author).toBe('RideBox Coach');
    expect(w.steps).toHaveLength(3);
  });
  it('rejects unknown names, tiny or absurd workouts', () => {
    expect(() => resolveChoice(lib_('Nope'), lib)).toThrow(/No library workout/);
    expect(() => resolveChoice(own({ ...claudeWorkout, text: '1m @60%' }), lib)).toThrow(/too short/);
    expect(() => resolveChoice(own({ ...claudeWorkout, text: '20m @900%' }), lib)).toThrow(/unrealistic/);
    expect(() => resolveChoice(own({ ...claudeWorkout, text: 'ride hard' }), lib)).toThrow();
    expect(() => resolveChoice(own(NONE), lib)).toThrow(/No workout/);
  });
});

describe('planFromOutput', () => {
  const input: PlanInput = {
    goal: 'Gran fondo',
    eventType: 'Gran fondo',
    eventDate: '2027-03-20',
    startDate: '2026-11-23',
    endDate: '2027-03-21',
    weeklyHours: 7,
    days: { mon: 0, tue: 60, wed: 60, thu: 60, fri: 0, sat: 180, sun: 120 },
    experience: 'some',
    detailUntil: '2026-12-13',
  };
  const out: PlanOutput = {
    name: 'Fondo build',
    summary: 'Base then build.',
    phases: [{ name: 'Base', start: '2026-11-23', end: '2027-01-17', focus: 'aerobic' }],
    weeks: [{ start: '2026-11-23', focus: 'Base 1', target_tss: 350, target_hours: 6, notes: '' }],
    workouts: [
      { date: '2026-11-24', ...lib_('Sweet Spot 3x12'), rationale: 'r' },
      { date: '2026-11-25', ...own(claudeWorkout), rationale: 'r' },
      { date: '2026-11-26', ...lib_('Missing'), rationale: 'r' },
      { date: '2026-10-01', ...lib_('Endurance 60'), rationale: 'r' },
    ],
  };
  it('builds the plan and calendar items, skipping bad workouts with a reason', () => {
    const r = planFromOutput(out, input, lib, []);
    expect(r.plan).toMatchObject({ name: 'Fondo build', active: true, start: '2026-11-23' });
    expect(r.items.map((i) => [i.date, i.workout.name, i.phase, i.planId === r.plan.id])).toEqual([
      ['2026-11-24', 'Sweet Spot 3x12', 'Base', true],
      ['2026-11-25', 'Threshold 3x10', 'Base', true],
    ]);
    expect(r.problems).toHaveLength(2);
  });
});

describe('reviewAdaptation', () => {
  const cal = [pw('a', '2026-11-20'), pw('b', '2026-11-21'), pw('d', '2026-11-18', 'done')];
  it('previews each change and flags invalid ones', () => {
    const r = reviewAdaptation(
      {
        summary: 's',
        changes: [
          { op: 'move', id: 'a', date: '2026-11-22', ...lib_(''), reason: 'rest first' },
          { op: 'replace', id: 'b', date: '', ...lib_('Endurance 60'), reason: 'tired' },
          { op: 'add', id: '', date: '2026-11-24', ...own(claudeWorkout), reason: 'fill' },
          { op: 'remove', id: 'd', date: '', ...lib_(''), reason: 'x' },
          { op: 'move', id: 'zz', date: '2026-11-22', ...lib_(''), reason: 'x' },
          { op: 'add', id: '', date: '2027-05-01', ...lib_('Endurance 60'), reason: 'x' },
        ],
      },
      cal,
      lib,
      '2026-11-19',
      '2026-12-03',
    );
    expect(r[0].after).toMatchObject({ id: 'a', date: '2026-11-22', origin: 'adapt' });
    expect(r[1].after).toMatchObject({ id: 'b', date: '2026-11-21' });
    expect(r[1].after!.workout.name).toBe('Endurance 60');
    expect(r[2].after!.workout.name).toBe('Threshold 3x10');
    expect(r[3].problem).toMatch(/already done/);
    expect(r[4].problem).toMatch(/isn’t on the calendar/);
    expect(r[5].problem).toMatch(/outside/);
  });
});

describe('todayOptions', () => {
  it('keeps valid options', () => {
    const r = todayOptions({ summary: 's', options: [{ ...lib_('Endurance 60'), reason: 'easy' }, { ...lib_('nope'), reason: 'x' }] }, lib);
    expect(r.options).toHaveLength(1);
    expect(r.problems).toHaveLength(1);
  });
});

describe('buildContext', () => {
  it('summarizes training for the coach', () => {
    const c = buildContext({ settings: DEFAULT_SETTINGS, rides: [], acts: [], calendar: [pw('a', '2026-11-20')], plans: [], library: lib, today: '2026-11-19' });
    expect(c.athlete.ftp).toBe(DEFAULT_SETTINGS.ftp);
    expect(c.upcoming).toHaveLength(1);
    expect(c.upcoming[0]).toMatchObject({ id: 'a', name: lib[0].name, zone: 'sweetspot' });
    expect(c.library.length).toBe(lib.length);
    expect(c.weeklyHistory.length).toBeGreaterThanOrEqual(8);
  });
});

describe('SSE parsing', () => {
  it('reads events split across chunks', async () => {
    const enc = new TextEncoder();
    const parts = ['data: {"type":"status","te', 'xt":"hi"}\n\ndata: {"type":"result","data":{"x":1},', '"usage":{"input":1,"output":2,"cacheRead":0}}\n\n'];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(p));
        c.close();
      },
    });
    const got = [];
    for await (const e of readEvents(body)) got.push(e.type);
    expect(got).toEqual(['status', 'result']);
  });
});


describe('adaptSuggestion', () => {
  const plan = { id: 'p', name: 'P', goal: 'g', start: '2026-11-01', end: '2027-02-01', phases: [], createdAt: 0, active: true };
  const item = (id: string, date: string, status: PlannedWorkout['status'] = 'planned') => ({ ...pw(id, date, status), planId: 'p' });
  it('offers a review after missed workouts, once', () => {
    const cal = [item('a', '2026-11-17', 'missed'), item('b', '2026-12-10')];
    expect(adaptSuggestion(plan, cal, '2026-11-19')?.reason).toBe('missed');
    expect(adaptSuggestion(plan, cal, '2026-11-19', '2026-11-18')).toBeNull();
  });
  it('offers to extend when detailed workouts run out within a week', () => {
    const s = adaptSuggestion(plan, [item('a', '2026-11-22')], '2026-11-19');
    expect(s).toMatchObject({ reason: 'extend', from: '2026-11-23', to: '2026-12-06' });
    expect(adaptSuggestion(plan, [], '2026-11-19')).toMatchObject({ reason: 'extend', from: '2026-11-19' });
  });
  it('stays quiet without an active plan or after it ends', () => {
    expect(adaptSuggestion(undefined, [], '2026-11-19')).toBeNull();
    expect(adaptSuggestion(plan, [], '2027-03-01')).toBeNull();
  });
});

describe('answer schemas', () => {
  // structured outputs rejects schemas whose grammar gets too big; optional
  // fields and unions are what blow it up, so keep them at zero
  it('have no optional properties or unions', () => {
    const walk = (node: unknown, path: string): string[] => {
      if (!node || typeof node !== 'object') return [];
      const n = node as { type?: unknown; properties?: Record<string, unknown>; required?: string[]; items?: unknown; anyOf?: unknown };
      const bad: string[] = [];
      if (n.anyOf || Array.isArray(n.type)) bad.push(`${path}: union`);
      if (n.properties) {
        for (const k of Object.keys(n.properties)) {
          if (!n.required?.includes(k)) bad.push(`${path}.${k}: optional`);
          bad.push(...walk(n.properties[k], `${path}.${k}`));
        }
      }
      if (n.items) bad.push(...walk(n.items, `${path}[]`));
      return bad;
    };
    for (const [kind, schema] of Object.entries(SCHEMAS)) expect(walk(schema, kind)).toEqual([]);
  });
});
