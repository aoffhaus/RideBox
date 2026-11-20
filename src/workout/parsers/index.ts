import type { Workout } from '../model';
import { parseZwo } from './zwo';
import { parseErgMrc } from './erg';
import { parseRideBoxJson } from './json';
import { parseText } from './text';
import { looksLikeTrainerRoad, parseTrainerRoadJson } from './trainerroad';

export { parseZwo, toZwo } from './zwo';
export { parseErgMrc, toMrc } from './erg';
export { parseRideBoxJson, toRideBoxJson } from './json';
export { parseText, toText } from './text';
export { parseTrainerRoadJson } from './trainerroad';

/** Detects the format from the file name and/or content and parses it. */
export function parseWorkout(content: string, fileName = ''): Workout {
  const name = fileName.toLowerCase();
  const trimmed = content.trim().replace(/^﻿/, '');
  if (name.endsWith('.zwo') || trimmed.startsWith('<')) return parseZwo(trimmed);
  if (name.endsWith('.erg') || name.endsWith('.mrc') || /\[COURSE (HEADER|DATA)\]/i.test(trimmed)) {
    return parseErgMrc(trimmed, fileName);
  }
  // Strip ```json fences that often wrap pasted LLM output
  const unfenced = trimmed.replace(/^```(?:json|xml|text)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (unfenced !== trimmed) return parseWorkout(unfenced, fileName);
  if (name.endsWith('.json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const j = JSON.parse(trimmed);
    const hasSteps = Array.isArray(j) || Array.isArray(j?.steps);
    if (!hasSteps && looksLikeTrainerRoad(j)) return parseTrainerRoadJson(j);
    return parseRideBoxJson(j);
  }
  return parseText(trimmed, fileName.replace(/\.[^.]+$/, '') || 'Custom workout');
}
