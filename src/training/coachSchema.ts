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
  /** 1 = exhausted … 5 = great */
  feel: number;
  note?: string;
}

export type CoachRequest =
  | { kind: 'plan'; context: CoachContext; input: PlanInput }
  | { kind: 'adapt'; context: CoachContext; input: AdaptInput }
  | { kind: 'today'; context: CoachContext; input: TodayInput };

// ---------- responses ----------

/** A workout in RideBox JSON form: power/from/to in % FTP, duration in seconds. */
export interface CoachStep {
  type: 'steady' | 'ramp' | 'free' | 'repeat';
  duration?: number;
  power?: number;
  from?: number;
  to?: number;
  cadence?: number;
  label?: string;
  count?: number;
  steps?: CoachStep[];
}
export interface CoachWorkout {
  name: string;
  description: string;
  steps: CoachStep[];
}

/** Either a library workout by exact name, or a new one. */
export interface WorkoutChoice {
  library_name?: string;
  workout?: CoachWorkout;
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
  /** calendar item id (replace / move / remove) */
  id?: string;
  /** new date (move / add, or replace on another day) */
  date?: string;
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

const INNER_STEP = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['steady', 'ramp', 'free'] },
    duration: { type: 'integer', description: 'seconds' },
    power: { type: 'integer', description: 'steady target, % of FTP' },
    from: { type: 'integer', description: 'ramp start, % of FTP' },
    to: { type: 'integer', description: 'ramp end, % of FTP' },
    cadence: { type: 'integer', description: 'rpm, only when it matters' },
    label: { type: 'string' },
  },
  required: ['type', 'duration'],
  additionalProperties: false,
} as const;

const STEP = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['steady', 'ramp', 'free', 'repeat'] },
    duration: { type: 'integer', description: 'seconds (not for repeat)' },
    power: { type: 'integer', description: 'steady target, % of FTP' },
    from: { type: 'integer', description: 'ramp start, % of FTP' },
    to: { type: 'integer', description: 'ramp end, % of FTP' },
    cadence: { type: 'integer' },
    label: { type: 'string' },
    count: { type: 'integer', description: 'repeat only: number of repetitions' },
    steps: { type: 'array', items: INNER_STEP, description: 'repeat only: the steps repeated' },
  },
  required: ['type'],
  additionalProperties: false,
} as const;

const WORKOUT = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string', description: 'one or two sentences: purpose and how to ride it' },
    steps: { type: 'array', items: STEP },
  },
  required: ['name', 'description', 'steps'],
  additionalProperties: false,
} as const;

const CHOICE_PROPS = {
  library_name: { type: 'string', description: 'exact name of a library workout to reuse' },
  workout: WORKOUT,
} as const;

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
        required: ['date', 'rationale'],
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
          id: { type: 'string', description: 'calendar item id for replace / move / remove' },
          date: { type: 'string', format: 'date' },
          ...CHOICE_PROPS,
          reason: { type: 'string' },
        },
        required: ['op', 'reason'],
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
        required: ['reason'],
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
