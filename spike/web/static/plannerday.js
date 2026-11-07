// Planner day in an EXPLICIT time zone. The browser's default time zone is never used, so
// LibreWolf's privacy.resistFingerprinting (which reports UTC) cannot shift the day.

/** @returns {{y:number,m:number,d:number,h:number,min:number}} wall-clock parts in timeZone */
export function wallClock(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute") };
}

/** Planner day "YYYY-MM-DD" for `date` in `timeZone`, rolling over at `rollover` ("HH:MM"). */
export function plannerDay(date, timeZone, rollover) {
  const [rh, rm] = rollover.split(":").map(Number);
  const w = wallClock(date, timeZone);
  // Date-only arithmetic in UTC, so DST transitions cannot skip or repeat a day.
  let t = Date.UTC(w.y, w.m - 1, w.d);
  if (w.h * 60 + w.min < rh * 60 + rm) t -= 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/** What the browser itself reports, for the diagnostics panel. */
export function defaultTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
