// Pure utilities for the event-driven clock. No I/O.
//
// Phases (and any deadline) are derived from the quest's progress counter —
// how many distinct clock.advances_on events have fired so far this session
// — never from elapsed turns or real time. A player who asks twenty
// thorough questions without triggering a new advances_on event doesn't
// move the clock at all; only genuine plot progress does.
//
// story_time (below) is a separate, fully optional layer: pure narrative
// flavor text for quests that want it, never used to derive phase or check
// a deadline.

import type { ClockPhaseSpec } from "./validator.ts";

/**
 * Which declared phase a given progress count falls into. Phases are an
 * ordered, non-circular list of ascending thresholds: phase i covers
 * progress in [0, phases[0].until) for i=0, then [phases[i-1].until,
 * phases[i].until) for each next one. Progress at or beyond every threshold
 * falls into the last-declared phase — there's no wraparound, since a
 * progress counter only ever goes up.
 */
export function derivePhaseFromProgress(phases: ClockPhaseSpec[], progress: number): string {
  for (const phase of phases) {
    if (progress < phase.until) return phase.name;
  }
  return phases[phases.length - 1]!.name;
}

/** Adds minutes to a story-time string, returning the same "YYYY-MM-DDTHH:MM:SS" format. Only relevant when a quest configures optional story_time flavor. */
export function addMinutes(isoDateTime: string, minutes: number): string {
  const date = new Date(`${isoDateTime}Z`);
  date.setUTCMinutes(date.getUTCMinutes() + minutes);
  return date.toISOString().slice(0, 19);
}

/** Just the time-of-day, e.g. "07:15" — for showing the model, never the raw machine datetime. Only relevant when a quest configures optional story_time flavor. */
export function formatTimeOfDay(isoDateTime: string): string {
  const match = isoDateTime.match(/T(\d{2}:\d{2})/);
  if (!match) throw new Error(`Cannot extract time of day from '${isoDateTime}'`);
  return match[1]!;
}
