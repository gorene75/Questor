// Pure utilities for v3's minutes-based story-time clock. No I/O.
// Story-time is a naive "YYYY-MM-DDTHH:MM:SS" string — never timezone-aware,
// since it's fictional time, not a real-world instant. Arithmetic below is
// pinned to UTC internally purely so the running environment's own local
// timezone can never skew the result; nothing here is ever read back as a
// real calendar date.

import type { ClockPhaseSpec } from "./validator.ts";

function parseHHMM(hhmm: string): number {
  const match = hhmm.match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid HH:MM time '${hhmm}'`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function timeOfDayMinutes(isoDateTime: string): number {
  const match = isoDateTime.match(/T(\d{2}):(\d{2})/);
  if (!match) throw new Error(`Cannot extract time of day from '${isoDateTime}'`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Which declared phase a story-time falls into, by time-of-day alone (the
 * date doesn't matter). Phase i runs from phase (i-1)'s `until` to its own
 * `until`, wrapping circularly — so the last phase's `until` is implicitly
 * the first phase's start, which is what lets a phase like "night" span
 * midnight without special-casing.
 */
export function derivePhase(phases: ClockPhaseSpec[], storyTime: string): string {
  const nowMinutes = timeOfDayMinutes(storyTime);
  const n = phases.length;
  for (let i = 0; i < n; i++) {
    const startMinutes = parseHHMM(phases[(i - 1 + n) % n]!.until);
    const endMinutes = parseHHMM(phases[i]!.until);
    if (startMinutes <= endMinutes) {
      if (nowMinutes >= startMinutes && nowMinutes < endMinutes) return phases[i]!.name;
    } else {
      // this phase's range wraps past midnight
      if (nowMinutes >= startMinutes || nowMinutes < endMinutes) return phases[i]!.name;
    }
  }
  return phases[n - 1]!.name; // unreachable if phases cover the full 24h, but never leaves phase undefined
}

/** Adds minutes to a story-time string, returning the same "YYYY-MM-DDTHH:MM:SS" format. */
export function addMinutes(isoDateTime: string, minutes: number): string {
  const date = new Date(`${isoDateTime}Z`);
  date.setUTCMinutes(date.getUTCMinutes() + minutes);
  return date.toISOString().slice(0, 19);
}

/**
 * Same-format ISO 8601 strings compare correctly with plain string
 * comparison — no parsing needed. True once `storyTime` has reached or
 * passed `deadline`.
 */
export function hasReached(storyTime: string, deadline: string): boolean {
  return storyTime >= deadline;
}

/** Just the time-of-day, e.g. "07:15" — for showing the model, never the raw machine datetime. */
export function formatTimeOfDay(isoDateTime: string): string {
  const match = isoDateTime.match(/T(\d{2}:\d{2})/);
  if (!match) throw new Error(`Cannot extract time of day from '${isoDateTime}'`);
  return match[1]!;
}
