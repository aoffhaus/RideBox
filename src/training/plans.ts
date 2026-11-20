// Editing and removing training plans. Pure: the caller saves the results.

import type { DayKey, PlanPhase, PlannedWorkout, TrainingPlan } from './model';

/** Workouts of a plan that haven't been ridden yet (done/missed ones are history and stay). */
export function upcomingOf(plan: TrainingPlan, calendar: PlannedWorkout[]): PlannedWorkout[] {
  return calendar.filter((c) => c.planId === plan.id && c.status === 'planned');
}

/** Planned workouts that fall outside a plan's dates (after its start or end moved). */
export function outsideDates(plan: TrainingPlan, calendar: PlannedWorkout[]): PlannedWorkout[] {
  return upcomingOf(plan, calendar).filter((c) => c.date < plan.start || c.date > plan.end);
}

/** Trim phases to the plan's dates, dropping any that end up empty. */
export function clipPhases(phases: PlanPhase[], start: DayKey, end: DayKey): PlanPhase[] {
  return phases
    .map((p) => ({ ...p, start: p.start < start ? start : p.start, end: p.end > end ? end : p.end }))
    .filter((p) => p.start <= p.end)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

/** Fold an edited plan back together: clip its phases and keep the coach's saved input in step. */
export function normalizePlan(plan: TrainingPlan): TrainingPlan {
  const p: TrainingPlan = { ...plan, phases: clipPhases(plan.phases, plan.start, plan.end) };
  if (p.input) {
    p.input = {
      ...p.input,
      goal: p.goal,
      eventDate: p.eventDate,
      startDate: p.start,
      endDate: p.end,
      detailUntil: p.input.detailUntil > p.end ? p.end : p.input.detailUntil,
    };
  }
  return p;
}

/** Make one plan the active one (or none), leaving the others inactive. */
export function setActive(plans: TrainingPlan[], id: string | null): TrainingPlan[] {
  return plans.filter((p) => p.active !== (p.id === id)).map((p) => ({ ...p, active: p.id === id }));
}
