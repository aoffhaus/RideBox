// The contract between the browser and the Claude coach (worker/coach.ts):
// what the app sends as context, what each request asks for, and the JSON
// schemas Claude's answers must follow (enforced with structured outputs).
// Shared by the Worker and the app, so it must not touch the DOM.

export type CoachKind = 'plan' | 'adapt' | 'today';

// ---------- context the app sends with every request ----------

export interface CoachContext {
  today: string; // YYYY-MM-DD
  athlete: {
    ftp: number;
    weightKg: number;
    maxHr: number;
    ftpEstimate?: number;
    /** progression level per zone (1-10), null = not rated yet */
    levels: Record<string, number | null>;
  };
  fitness: { ctl: number; atl: number; tsb: number; ctlChange7d: number };
  weeklyHistory: { week: string; tss: number; hours: number; activities: number }[];
  recent: {
    date: string;
    name: string;
    source: 'ridebox' | 'strava';
    minutes: number;
    tss: number;
    zone?: string;
    level?: number;
    outcome?: 'pass' | 'struggle' | 'fail';
    compliance?: number;
    feel?: number;
  }[];
  upcoming: {
    id: string;
    date: string;
    name: string;
    zone: string;
    level: number;
    minutes: number;
    tss: number;
    status: string;
    origin: string;
  }[];
  plan?: { name: string; goal: string; eventDate?: string; start: string; end: string; phases: { name: string; start: string; end: string; focus: string }[]; notes?: string };
  library: { name: string; zone: string; level: number; minutes: number; tss: number }[];
}

// ---------- request inputs ----------

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export interface PlanInput {
  goal: string;
  eventType: string;
  eventDate?: string;
  startDate: string;
  endDate: string;
  weeklyHours: number;
  /** max minutes available per weekday (0 = rest day) */
  days: Record<Weekday, number>;
  experience: 'new' | 'some' | 'experienced';
  notes?: string;
  /** dates to fill in with full workouts now; later weeks come from adaptations */
  detailUntil: string;
}

export interface AdaptInput {
  reason: 'after_ride' | 'missed' | 'weekly' | 'extend' | 'manual';
  note?: string;
  /** change / fill workouts only between these dates */
  from: string;
  to: string;
  /** the user's available minutes per weekday, if a plan has them */
  days?: Record<Weekday, number>;
}

export interface TodayInput {
  minutes: number;
  /** 1 = exhausted … 5 = great; absent when the rider only asked for alternatives */
  feel?: number;
  note?: string;
  /** the day to recommend for (defaults to today) */
  date?: string;
  /** the calendar workout the rider wants alternatives to */
  planned?: { name: string; zone: string; level: number; minutes: number; tss: number; rationale?: string };
  /** true: exactly three different options instead of the planned workout */
  alternatives?: boolean;
}

export type CoachRequest =
  | { kind: 'plan'; context: CoachContext; input: PlanInput }
  | { kind: 'adapt'; context: CoachContext; input: AdaptInput }
  | { kind: 'today'; context: CoachContext; input: TodayInput };

// ---------- responses ----------

/**
 * A new workout written in RideBox shorthand (one step per line, see
 * src/workout/parsers/text.ts), e.g. "10m 45-70%\n3x(12m @90% \"Sweet spot\", 4m @50%)\n8m 60-40%".
 * Text keeps the answer schema simple enough for structured outputs.
 */
export interface CoachWorkout {
  name: string;
  description: string;
  text: string;
}

/** Either a library workout by exact name, or a new one. Unused fields are empty strings. */
export interface WorkoutChoice {
  library_name: string;
  workout: CoachWorkout;
}

export interface PlanOutput {
  name: string;
  summary: string;
  phases: { name: string; start: string; end: string; focus: string }[];
  weeks: { start: string; focus: string; target_tss: number; target_hours: number; notes: string }[];
  workouts: (WorkoutChoice & { date: string; rationale: string })[];
}

export interface AdaptChange extends WorkoutChoice {
  op: 'replace' | 'move' | 'remove' | 'add';
  /** calendar item id (replace / move / remove), "" for add */
  id: string;
  /** new date (move / add, or replace on another day), "" to keep the date */
  date: string;
  reason: string;
}
export interface AdaptOutput {
  summary: string;
  changes: AdaptChange[];
}

export interface TodayOutput {
  summary: string;
  options: (WorkoutChoice & { reason: string })[];
}

// ---------- JSON schemas (structured outputs) ----------

// Every property is required (no optional fields or unions): structured
// outputs compiles the schema into a grammar, and optional nested fields make
// that grammar too big. "Not applicable" is an empty string instead.
const WORKOUT = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'empty when using a library workout' },
    description: { type: 'string', description: 'one or two sentences: purpose and how to ride it' },
    text: { type: 'string', description: 'RideBox shorthand, one step per line; empty when using a library workout' },
  },
  required: ['name', 'description', 'text'],
  additionalProperties: false,
} as const;

const CHOICE_PROPS = {
  library_name: { type: 'string', description: 'exact name of a library workout to reuse, or empty to write a new workout' },
  workout: WORKOUT,
} as const;
const CHOICE_REQ = ['library_name', 'workout'] as const;

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    summary: { type: 'string', description: 'two to four sentences on the approach' },
    phases: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, start: { type: 'string', format: 'date' }, end: { type: 'string', format: 'date' }, focus: { type: 'string' } },
        required: ['name', 'start', 'end', 'focus'],
        additionalProperties: false,
      },
    },
    weeks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'string', format: 'date' },
          focus: { type: 'string' },
          target_tss: { type: 'integer' },
          target_hours: { type: 'number' },
          notes: { type: 'string' },
        },
        required: ['start', 'focus', 'target_tss', 'target_hours', 'notes'],
        additionalProperties: false,
      },
    },
    workouts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { date: { type: 'string', format: 'date' }, ...CHOICE_PROPS, rationale: { type: 'string' } },
        required: ['date', ...CHOICE_REQ, 'rationale'],
        additionalProperties: false,
      },
    },
  },
  required: ['name', 'summary', 'phases', 'weeks', 'workouts'],
  additionalProperties: false,
} as const;

export const ADAPT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'what changed and why, in plain words; say so if nothing needs to change' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['replace', 'move', 'remove', 'add'] },
          id: { type: 'string', description: 'calendar item id for replace / move / remove; empty for add' },
          date: { type: 'string', description: 'YYYY-MM-DD for move / add (or to replace on another day); empty to keep the date' },
          ...CHOICE_PROPS,
          reason: { type: 'string' },
        },
        required: ['op', 'id', 'date', ...CHOICE_REQ, 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'changes'],
  additionalProperties: false,
} as const;

export const TODAY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: { ...CHOICE_PROPS, reason: { type: 'string' } },
        required: [...CHOICE_REQ, 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'options'],
  additionalProperties: false,
} as const;

export const SCHEMAS: Record<CoachKind, object> = { plan: PLAN_SCHEMA, adapt: ADAPT_SCHEMA, today: TODAY_SCHEMA };

/** Server-sent events from /api/coach/*. */
export type CoachEvent =
  | { type: 'status'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'progress'; outputTokens: number }
  | { type: 'result'; data: unknown; usage: { input: number; output: number; cacheRead: number } }
  | { type: 'error'; message: string };
