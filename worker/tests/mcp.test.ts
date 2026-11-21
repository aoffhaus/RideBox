import { describe, expect, it } from 'vitest';
import { D1Kv } from '../oauthKv';
import { fromLite, loadRiderData, saveChanges, shiftToLocal, toLite, tzOffsetMs } from '../mcp/data';
import { handleMcp, ToolError, validateArgs, type Tool } from '../mcp/protocol';
import { TOOLS, type ToolCtx } from '../mcp/tools';
import { mcpApiHandler } from '../mcp';
import { writeDoc } from '../sync';
import { parseText, toText } from '../../src/workout/parsers';
import { dayKey } from '../../src/training/load';
import type { RideRecord } from '../../src/app/recorder';
import { fakeD1 } from './fakeD1';

const INFO = { name: 't', title: 'T', version: '1', instructions: 'hi' };
const post = (body: unknown) => new Request('https://x/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('MCP protocol', () => {
  const echo: Tool<null> = {
    name: 'echo',
    title: 'Echo',
    description: 'd',
    inputSchema: { required: ['n'], properties: { n: { type: 'integer', minimum: 1 } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async (a) => {
      if (a.n === 13) throw new ToolError('unlucky');
      if (a.n === 99) throw new Error('boom');
      return { n: a.n };
    },
  };
  const call = async (body: unknown) => {
    const res = await handleMcp(post(body), [echo], async () => null, INFO);
    return { status: res.status, body: (res.status === 202 ? null : await res.json()) as any };
  };

  it('negotiates the protocol version', async () => {
    const a = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect(a.body.result.protocolVersion).toBe('2025-06-18');
    expect(a.body.result.capabilities.tools).toBeDefined();
    expect(a.body.result.instructions).toBe('hi');
    const b = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect(b.body.result.protocolVersion).toBe('2025-11-25');
  });
  it('accepts notifications with 202 and rejects GET', async () => {
    expect((await call({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    expect((await handleMcp(new Request('https://x/mcp'), [echo], async () => null, INFO)).status).toBe(405);
  });
  it('lists and calls tools, reporting tool errors as results', async () => {
    const l = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(l.body.result.tools[0]).toMatchObject({ name: 'echo', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } });
    const ok = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { n: 3 } } });
    expect(JSON.parse(ok.body.result.content[0].text)).toEqual({ n: 3 });
    const bad = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { n: 1.5 } } });
    expect(bad.body.result).toMatchObject({ isError: true, content: [{ text: 'n must be a whole number.' }] });
    const tErr = await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { n: 13 } } });
    expect(tErr.body.result.content[0].text).toBe('unlucky');
    const crash = await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: { n: 99 } } });
    expect(crash.body.result.isError).toBe(true);
    expect(crash.body.result.content[0].text).not.toContain('boom');
    const unknown = await call({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } });
    expect(unknown.body.error.code).toBe(-32602);
  });
  it('handles batches and bad JSON', async () => {
    const b = await call([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'nope' },
    ]);
    expect(b.body).toHaveLength(2);
    expect(b.body[1].error.code).toBe(-32601);
    const res = await handleMcp(new Request('https://x/mcp', { method: 'POST', body: '{' }), [echo], async () => null, INFO);
    expect(res.status).toBe(400);
  });
  it('validates arguments', () => {
    const s = { required: ['d'], properties: { d: { type: 'string' as const, pattern: '^\\d{4}$' }, e: { type: 'string' as const, enum: ['a'] } }, additionalProperties: false };
    expect(() => validateArgs(s, {})).toThrow('d is required.');
    expect(() => validateArgs(s, { d: '12' })).toThrow('wrong format');
    expect(() => validateArgs(s, { d: '1234', e: 'b' })).toThrow('one of: a');
    expect(() => validateArgs(s, { d: '1234', x: 1 })).toThrow('Unknown argument "x"');
    expect(validateArgs(s, { d: '1234' })).toEqual({ d: '1234' });
  });
});

describe('workout shorthand round trip', () => {
  it('writes text that parses back to the same workout', () => {
    const src = '10m 45-70%\n3x(12m @92% "Sweet spot", 4m @50%)\n5x(1m @110% 100rpm, 1m @55%)\n5m @150w\n10m free\n1:15:30 60-40%';
    const w = parseText(src, 'X');
    expect(parseText(toText(w), 'X').steps).toEqual(w.steps);
  });
  it('keeps labels with commas and parentheses parseable', () => {
    const w = { name: 'L', steps: [{ type: 'steady' as const, duration: 60, power: 0.9, label: 'Over (hard), go' }] };
    expect(parseText(toText(w)).steps[0]).toMatchObject({ duration: 60, power: 0.9, label: 'Over hard go' });
  });
});

describe('time zones', () => {
  it('shifts timestamps onto the rider’s wall clock', () => {
    const t = Date.UTC(2026, 10, 20, 6, 30); // 20 Nov 06:30 UTC = 19 Nov 22:30 in Los Angeles
    expect(tzOffsetMs('America/Los_Angeles', t)).toBe(-8 * 3600_000);
    expect(dayKey(shiftToLocal('America/Los_Angeles', t))).toBe('2026-11-19');
    expect(tzOffsetMs('America/Los_Angeles', Date.UTC(2026, 6, 1))).toBe(-7 * 3600_000); // daylight time
    expect(tzOffsetMs('UTC', t)).toBe(0);
  });
});

describe('D1-backed KV for OAuth', () => {
  it('gets, puts with expiry and metadata, deletes and lists by prefix', async () => {
    let now = 1000;
    const kv = new D1Kv(await fakeD1(), () => now);
    await kv.put('grant:a:1', JSON.stringify({ x: 1 }), { metadata: { c: 'k' } });
    await kv.put('grant:a:2', 'two', { expirationTtl: 60 });
    await kv.put('grant:b:1', 'b');
    await kv.put('token:a', 't');
    expect(await kv.get('grant:a:1', { type: 'json' })).toEqual({ x: 1 });
    expect(await kv.get('grant:a:2')).toBe('two');
    const all = await kv.list({ prefix: 'grant:' });
    expect(all.keys.map((k) => k.name)).toEqual(['grant:a:1', 'grant:a:2', 'grant:b:1']);
    expect(all.keys[0].metadata).toEqual({ c: 'k' });
    expect(all.keys[1].expiration).toBe(1060);
    const p1 = await kv.list({ prefix: 'grant:', limit: 2 });
    expect(p1.list_complete).toBe(false);
    const p2 = await kv.list({ prefix: 'grant:', limit: 2, cursor: p1.cursor });
    expect(p2).toEqual({ keys: [{ name: 'grant:b:1' }], list_complete: true });
    now = 2000; // past the TTL
    expect(await kv.get('grant:a:2')).toBeNull();
    expect((await kv.list({ prefix: 'grant:a:' })).keys).toHaveLength(1);
    await kv.delete('token:a');
    expect(await kv.get('token:a')).toBeNull();
  });
});

// ---------- tools against a real (SQLite) database ----------

const ss = { name: 'Sweet Spot 3x12', steps: [{ type: 'ramp', duration: 600, from: 0.45, to: 0.7 }, { type: 'repeat', count: 3, steps: [{ type: 'steady', duration: 720, power: 0.9 }, { type: 'steady', duration: 240, power: 0.5 }] }, { type: 'steady', duration: 600, power: 0.5 }] };

async function seeded() {
  const db = await fakeD1();
  const docs: Record<string, [string, unknown][]> = {
    kv: [['settings', { ftp: 250, riderKg: 70 }], ['timezone', 'UTC']],
    workouts: [['w1', { id: 'w1', workout: ss, source: 'builtin', createdAt: 1 }]],
    calendar: [['c1', { id: 'c1', date: '2099-01-05', workout: ss, status: 'planned', origin: 'plan', createdAt: 1 }]],
    plans: [['p1', { id: 'p1', name: 'Build', goal: 'Fondo', start: '2099-01-01', end: '2099-03-01', phases: [{ name: 'Base', start: '2099-01-01', end: '2099-02-01', focus: '' }], createdAt: 1, active: true }]],
  };
  for (const [store, rows] of Object.entries(docs)) for (const [id, v] of rows) await writeDoc(db, { store, id, updated_at: 1, json: JSON.stringify(v) });
  return db;
}

async function tool(db: D1Database, name: string, args: Record<string, unknown> = {}) {
  const t = TOOLS.find((x) => x.name === name)!;
  let data: ReturnType<typeof loadRiderData> | null = null;
  const ctx: ToolCtx = { db, data: () => (data ??= loadRiderData(db)) };
  return t.run(validateArgs(t.inputSchema, args), ctx) as Promise<any>;
}

describe('connector tools', () => {
  it('schedules, moves, and undoes, writing synced docs browsers will pull', async () => {
    const db = await seeded();
    const s = await tool(db, 'schedule_workout', { date: '2099-01-07', library_name: 'sweet spot 3x12', rationale: 'Build' });
    expect(s.scheduled).toMatchObject({ date: '2099-01-07', name: 'Sweet Spot 3x12', zone: 'Sweet Spot', status: 'planned', phase: 'Base' });
    const row = await db.prepare("SELECT json, updated_at FROM docs WHERE store = 'calendar' AND id = ?").bind(s.scheduled.id).first<{ json: string; updated_at: number }>();
    expect(JSON.parse(row!.json)).toMatchObject({ planId: 'p1', origin: 'adapt' });

    const m = await tool(db, 'move_workout', { id: 'c1', date: '2099-01-09' });
    expect(m.moved.date).toBe('2099-01-09');
    await tool(db, 'undo_change', { change_id: m.change_ids[0] });
    const cal = await tool(db, 'get_calendar', { from: '2099-01-05', to: '2099-01-09' });
    expect(cal.days.map((d: any) => d.date)).toEqual(['2099-01-05', '2099-01-07']);
    await expect(tool(db, 'undo_change', { change_id: m.change_ids[0] })).rejects.toThrow('already undone');
  });

  it('rejects unsafe or invalid workouts and unknown ids', async () => {
    const db = await seeded();
    await expect(tool(db, 'schedule_workout', { date: '2099-01-07', name: 'X', text: '20m @400%' })).rejects.toThrow('unrealistic');
    await expect(tool(db, 'schedule_workout', { date: '2099-02-30', library_name: 'Sweet Spot 3x12' })).rejects.toThrow('real date');
    await expect(tool(db, 'move_workout', { id: 'nope', date: '2099-01-07' })).rejects.toThrow('No calendar workout');
    await expect(tool(db, 'schedule_workout', { date: '2099-01-07' })).rejects.toThrow('library_name');
  });

  it('writes new shorthand workouts, settings and plans', async () => {
    const db = await seeded();
    const lib = await tool(db, 'save_library_workout', { name: 'Tempo 2x20', text: '10m 45-70%\n2x(20m @82%, 5m @50%)\n10m 50%' });
    expect(lib.saved).toMatchObject({ name: 'Tempo 2x20', zone: 'Tempo', minutes: 70 });
    const w = await tool(db, 'get_workout', { library_name: 'Tempo 2x20' });
    expect(w.text).toBe('10m 45%-70%\n2x(20m @82%, 5m @50%)\n10m @50%');
    await tool(db, 'update_athlete_settings', { ftp: 265 });
    expect((await tool(db, 'get_training_summary')).athlete.ftp).toBe(265);
    const p = await tool(db, 'create_plan', { name: 'New', goal: 'G', start_date: '2099-04-01', end_date: '2099-05-01' });
    expect(p.deactivated).toEqual(['Build']);
    const plan = await tool(db, 'get_plan');
    expect(plan.plan.name).toBe('New');
    expect(plan.other_plans[0]).toMatchObject({ name: 'Build', active: false });
  });

  it('counts saved power streams of Strava rides in the FTP estimate', async () => {
    const db = await seeded();
    const day = 86_400_000;
    const now = Date.now();
    const effort = (watts: number) => [...Array(300).fill(150), ...Array(1200).fill(watts), ...Array(300).fill(150)];
    const pm = (n: number, start: number, over: Record<string, unknown> = {}) => ({
      id: `strava-${n}`, stravaId: n, name: `Ride ${n}`, sportType: 'Ride', start, movingTime: 1800, distance: 0, deviceWatts: true, ...over,
    });
    const rbPower = effort(210);
    const rb = {
      id: 'rb1', name: 'RideBox', routeName: 'r', startTime: now - 5 * day, ftp: 250, laps: [],
      samples: rbPower.map((p, i) => ({ t: i * 1000, elapsed: i, power: p, speed: 0, distance: 0, altitude: 0 })),
      summary: { duration: rbPower.length, distance: 0, avgPower: 0, maxPower: 0, np: 0, if: 0, tss: 50, climb: 0, kj: 0 },
      strava: { status: 'done', activityId: 900 },
    };
    const acts = [
      pm(1, now - 3 * day), // power meter, streams saved: counts
      pm(2, now - 2 * day, { deviceWatts: false }), // estimated watts: ignored
      pm(900, now - 5 * day), // Strava's copy of the RideBox ride: ignored
      pm(3, now - 1 * day), // power meter, streams not downloaded yet
    ];
    const streams: [string, number[]][] = [['strava-1', effort(268)], ['strava-2', effort(400)], ['strava-900', effort(400)]];
    await writeDoc(db, { store: 'rides', id: 'rb1', updated_at: 1, json: JSON.stringify(rb) });
    for (const a of acts) await writeDoc(db, { store: 'strava_acts', id: a.id, updated_at: 1, json: JSON.stringify(a) });
    for (const [id, power] of streams) {
      await writeDoc(db, { store: 'strava_streams', id, updated_at: 1, json: JSON.stringify({ id, stravaId: 0, fetchedAt: 1, series: { length: power.length, power } }) });
    }
    const s = await tool(db, 'get_training_summary');
    expect(s.athlete.ftp_estimate).toMatchObject({ ftp: 255, best_20min_watts: 268, from: { source: 'strava', name: 'Ride 1' } });
    expect(s.notes.join(' ')).toContain('1 Strava power-meter ride from the last 90 days has no saved power data yet');
  });

  it('refuses to undo over a later change', async () => {
    const db = await seeded();
    const a = await tool(db, 'set_workout_note', { id: 'c1', note: 'one' });
    await tool(db, 'set_workout_note', { id: 'c1', note: 'two' });
    await expect(tool(db, 'undo_change', { change_id: a.change_ids[0] })).rejects.toThrow('changed since');
  });

  it('stamps writes after the stored copy so a fast browser clock can’t make them lose', async () => {
    const db = await seeded();
    const future = Date.now() + 60_000;
    await writeDoc(db, { store: 'calendar', id: 'c1', updated_at: future, json: JSON.stringify({ id: 'c1' }) });
    await saveChanges(db, 't', 's', [{ store: 'calendar', id: 'c1', value: { id: 'c1', note: 'x' } }]);
    const r = await db.prepare("SELECT updated_at, json FROM docs WHERE store = 'calendar' AND id = 'c1'").first<{ updated_at: number; json: string }>();
    expect(r!.updated_at).toBe(future + 1);
    expect(JSON.parse(r!.json).note).toBe('x');
  });
});

describe('ride index', () => {
  it('keeps only power from the samples', () => {
    const r = { id: 'r', samples: [{ power: 100.4, hr: 120 }, { power: 200 }], laps: [] } as unknown as RideRecord;
    const lite = toLite(r);
    expect(lite).toEqual({ id: 'r', laps: [], power: [100, 200] });
    expect(fromLite(lite).samples).toEqual([{ power: 100 }, { power: 200 }]);
  });
});

describe('MCP endpoint', () => {
  it('refuses tokens for emails no longer allowed', async () => {
    const db = await fakeD1();
    const req = post({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const ctx = (email: string) => ({ props: { email }, waitUntil() {}, passThroughOnException() {} }) as unknown as ExecutionContext;
    expect((await mcpApiHandler.fetch(req.clone(), { DB: db, ALLOWED_EMAILS: 'me@x.com' }, ctx('other@x.com'))).status).toBe(403);
    expect((await mcpApiHandler.fetch(req, { DB: db, ALLOWED_EMAILS: 'Me@X.com' }, ctx('me@x.com'))).status).toBe(200);
  });
});
