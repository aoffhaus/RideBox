// Claude coach: training plans, adaptations and today's pick.
//
// The browser sends its training context (fitness, levels, recent rides,
// calendar, library) plus what it wants. The Worker holds the API key, adds
// the coaching instructions, asks Claude for a structured JSON answer and
// streams progress back as server-sent events. The app validates every
// workout before anything touches the calendar, and the rider approves
// changes, so nothing here writes to their data.

import Anthropic from '@anthropic-ai/sdk';
import { SCHEMAS, type CoachEvent, type CoachKind, type CoachRequest } from '../src/training/coachSchema';

export interface CoachEnv {
  DB: D1Database;
  ANTHROPIC_API_KEY?: string;
  /** local testing only: point the SDK at a mock server */
  ANTHROPIC_BASE_URL?: string;
  COACH_DAILY_LIMIT?: string;
}

const MODEL = 'claude-opus-5-5';

const SYSTEM = `You are RideBox Coach, an experienced cycling coach who builds structured indoor and outdoor training for one rider. You work inside RideBox, an indoor training app that controls a smart trainer in ERG mode.

How you coach
- Base every decision on the rider's data in the context: FTP, progression levels, fitness (CTL), fatigue (ATL), form (TSB), recent rides with how they went, the calendar, and the time they have each day.
- Progressive overload with recovery: build for 2-3 weeks, then a recovery week at about 60% of the previous week's load (3:1 by default; 2:1 for riders who are new, older or under-recovered).
- Safe ramp: weekly CTL growth of about 3-6 points; up to 8 for short blocks with good recovery. Never jump weekly TSS more than about 15% on a normal build week.
- Hard days hard, easy days easy: no more than 2-3 intensity sessions per week, rarely on consecutive days. Fill the rest with endurance or recovery, or rest.
- Periodize toward the goal: base (aerobic endurance, tempo, sweet spot), build (threshold, VO2max), specialty (the event's demands: long climbs, crits, gravel surges, time trial pacing), then a 7-14 day taper that cuts volume 30-50% but keeps some intensity. Without an event, alternate build blocks with maintenance.
- Progression levels (1-10 per zone) say how hard a workout the rider can handle in that zone. A productive workout is 0 to +1 level above their current level; a stretch is +1 to +1.5. Never schedule workouts more than 1.5 above their level. A zone with no level is unrated: start with a moderate workout (about level 3).
- Respect the calendar: put workouts only on days with available time and never longer than that day's minutes. Weekends usually take the long rides.
- Outdoor rides from Strava count as real training. Don't double the load after a big outdoor weekend.

Adapting
- Missed key workout: move it to the next suitable day if it fits without stacking hard days; otherwise drop the less important session. Don't try to catch up on missed volume.
- Failed or struggled workout (outcome fail/struggle, feel 4-5): repeat the stimulus a little easier (about -0.5 to -1 level) and check recovery. Several in a row, or TSB below about -30: add recovery days.
- Workouts that felt easy (feel 1-2) with a pass: progress faster, choosing workouts nearer +1 level.
- Keep changes small and explain each one. If nothing needs to change, return no changes and say why.

Workouts
- Prefer the rider's library workouts: set library_name to the exact name and leave workout's fields empty. Otherwise set library_name to "" and write a new workout (name, description, text).
- A new workout's text is RideBox shorthand, one step per line:
    10m 45-70%                    ramp from 45% to 70% FTP
    20m @88%                      steady at 88% FTP
    3x(12m @92% "Sweet spot", 4m @50% "Recover")   repeat; labels in double quotes
    5x(1m @110% 100rpm, 1m @55%)  cadence target in rpm
    10m free                      no target (rider chooses)
  Durations: 30s, 5m, 1h, 1h15m. Power is % of FTP. No nested repeats.
- Always include a warm-up (8-15 minutes ramping from about 45% to 70%) and a cool-down (5-10 minutes). Label work intervals. Add cadence only when it is the point of the interval.
- Zones (% FTP): recovery <56, endurance 56-75, tempo 76-87, sweet spot 88-94, threshold 95-105, VO2max 106-120, anaerobic >120.
- Name workouts plainly ("Threshold 3x12", "Endurance 90"). Describe the purpose in one or two sentences.

Output
- Answer only with JSON matching the schema. Dates are YYYY-MM-DD and must fall in the requested range. Fields that don't apply are empty strings.
- Rationales and reasons are short (one sentence), concrete and written to the rider.`;

const TASKS: Record<CoachKind, string> = {
  plan: `Build a training plan from the plan request. Cover start_date to end_date with phases and one entry per week (start = that week's Monday). Write full workouts for every training day from start_date through detail_until; later weeks get only their week entry (focus, targets), and their workouts will be filled in later as the rider progresses. Keep upcoming calendar items that aren't part of a plan in mind (don't double up on those days).`,
  adapt: `Review how training is going and adjust the calendar between "from" and "to". You may replace, move or remove planned workouts (use their ids from "upcoming") and add workouts on empty training days. Never change workouts that are done. If the reason is "extend", fill every available training day in the range that has no workout, following the plan's week focus and targets.`,
  today: `Recommend what to ride today, given the time available, how the rider feels and their recent load and calendar. Offer one to three options, best first. If they feel bad or fatigue is high, include an easy option or say a rest day is best (as the summary, with an easy spin as the option).
If "date" is set, recommend for that day instead of today. If "planned" is set, the rider has that workout on the calendar for the day and wants something else: keep the plan's intent for the day (its zone and load, the days around it) unless how they feel says otherwise, and don't offer the planned workout itself. If "alternatives" is true, offer exactly three options that differ from each other (for example the same stimulus in a different format, a shorter or easier version, and a different focus that still fits the week).`,
};

const encoder = new TextEncoder();
const sse = (e: CoachEvent) => encoder.encode(`data: ${JSON.stringify(e)}\n\n`);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function usedToday(env: CoachEnv): Promise<{ day: string; requests: number }> {
  const day = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare('SELECT requests FROM coach_usage WHERE day = ?').bind(day).first<{ requests: number }>();
  return { day, requests: row?.requests ?? 0 };
}

/** Counts the request up front, so parallel or failing requests can't slip past the daily cap. */
async function reserve(env: CoachEnv, day: string) {
  await env.DB.prepare(
    `INSERT INTO coach_usage (day, requests, input_tokens, output_tokens) VALUES (?, 1, 0, 0)
     ON CONFLICT (day) DO UPDATE SET requests = requests + 1`,
  )
    .bind(day)
    .run();
}

async function record(env: CoachEnv, day: string, input: number, output: number) {
  await env.DB.prepare(
    `INSERT INTO coach_usage (day, requests, input_tokens, output_tokens) VALUES (?, 0, ?, ?)
     ON CONFLICT (day) DO UPDATE SET input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens`,
  )
    .bind(day, input, output)
    .run();
}

export function buildUserMessage(req: CoachRequest): string {
  return [
    `Task: ${req.kind}`,
    TASKS[req.kind],
    '',
    'Request:',
    JSON.stringify(req.input),
    '',
    'Rider context:',
    JSON.stringify(req.context),
  ].join('\n');
}

export function validRequest(kind: string, body: unknown): body is CoachRequest {
  if (!(kind in SCHEMAS) || !body || typeof body !== 'object') return false;
  const b = body as CoachRequest;
  return b.kind === kind && !!b.context && typeof b.context === 'object' && !!b.input && typeof b.input === 'object';
}

export async function coach(env: CoachEnv, req: Request, kind: string, ctx: ExecutionContext): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'The coach needs an Anthropic API key: run `npx wrangler secret put ANTHROPIC_API_KEY`.' }, 503);
  const body = await req.json().catch(() => null);
  if (!validRequest(kind, body)) return json({ error: 'Bad coach request.' }, 400);
  if (JSON.stringify(body).length > 400_000) return json({ error: 'Too much context.' }, 413);
  const limit = Number(env.COACH_DAILY_LIMIT ?? 40) || 40;
  const { day, requests } = await usedToday(env);
  if (requests >= limit) return json({ error: `Daily coach limit reached (${limit} requests). It resets at midnight UTC; raise COACH_DAILY_LIMIT in wrangler.jsonc if you need more.` }, 429);

  await reserve(env, day);
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined, timeout: 15 * 60_000, maxRetries: 2 });
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const out = writable.getWriter();
  const send = (e: CoachEvent) => out.write(sse(e)).catch(() => {});

  const run = async () => {
    try {
      await send({ type: 'status', text: 'Thinking it through…' });
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: kind === 'plan' ? 64000 : 32000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: kind === 'today' ? 'medium' : 'high', format: { type: 'json_schema', schema: SCHEMAS[kind as CoachKind] as Record<string, unknown> } },
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: buildUserMessage(body) }],
      });
      let outTokens = 0;
      let writing = false;
      let lastProgress = 0;
      for await (const ev of stream) {
        if (ev.type === 'content_block_start' && ev.content_block.type === 'text' && !writing) {
          writing = true;
          await send({ type: 'status', text: kind === 'plan' ? 'Writing your plan…' : 'Writing it up…' });
        } else if (ev.type === 'content_block_delta') {
          if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) await send({ type: 'thinking', text: ev.delta.thinking });
          if (ev.delta.type === 'text_delta') {
            outTokens += Math.ceil(ev.delta.text.length / 4);
            if (outTokens - lastProgress > 200) {
              lastProgress = outTokens;
              await send({ type: 'progress', outputTokens: outTokens });
            }
          }
        }
      }
      const msg = await stream.finalMessage();
      const u = msg.usage;
      await record(env, day, (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), u.output_tokens ?? 0);
      if (msg.stop_reason === 'refusal') throw new Error('Claude declined this request. Try rephrasing your goal or notes.');
      if (msg.stop_reason === 'max_tokens') throw new Error('The answer was too long and got cut off. Try a shorter plan or fewer detailed weeks.');
      const text = msg.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error('The coach returned something unreadable. Please try again.');
      }
      await send({ type: 'result', data, usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0 } });
    } catch (e) {
      console.error('coach', kind, e);
      const message =
        e instanceof Anthropic.RateLimitError
          ? 'Claude is busy (rate limited). Try again in a minute.'
          : e instanceof Anthropic.AuthenticationError
            ? 'The Anthropic API key was rejected. Set a valid ANTHROPIC_API_KEY secret.'
            : e instanceof Anthropic.APIError
              ? `Claude API error ${e.status ?? ''}: ${e.message}`
              : (e as Error).message;
      await send({ type: 'error', message });
    } finally {
      await out.close().catch(() => {});
    }
  };
  // keep the Worker alive while Claude works; the client reads events as they arrive
  ctx.waitUntil(run());
  return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
}
