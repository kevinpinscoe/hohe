// Planner-day helpers. A planner day is a plain "YYYY-MM-DD" string.
// The server is authoritative for the time zone and the rollover time (proposal §11.5). The
// client keeps a copy of both and works out the planner day itself while offline, always in
// that explicit zone and never the browser's default (LibreWolf's resistFingerprinting
// reports UTC).

export type Day = string;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** The planner day at `now` in `timeZone`, where times before `rollover` ("HH:MM") belong to the previous day. */
export function plannerDay(now: Date, timeZone: string, rollover: string): Day {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    // An unknown zone name: fall back to the server's default zone rather than the browser's.
    return plannerDay(now, 'America/New_York', rollover);
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  const [rh, rm] = (/^\d{2}:\d{2}$/.test(rollover) ? rollover : '03:00').split(':').map(Number);
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  return minutes < rh * 60 + rm ? addDays(day, -1) : day;
}

/** Day arithmetic on calendar dates, done in UTC so DST never shifts the date. */
export function addDays(day: Day, n: number): Day {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function daysBetween(a: Day, b: Day): number {
  const toUtc = (s: Day) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

export function parts(day: Day): { y: number; m: number; d: number } {
  const [y, m, d] = day.split('-').map(Number);
  return { y, m, d };
}

export function makeDay(y: number, m: number, d: number): Day {
  return `${y}-${pad(m)}-${pad(d)}`;
}

const utc = (day: Day) => {
  const { y, m, d } = parts(day);
  return new Date(Date.UTC(y, m - 1, d));
};

export function weekdayLong(day: Day): string {
  return utc(day).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}

export function weekdayShort(day: Day): string {
  return utc(day).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
}

export function monthLong(m: number): string {
  return new Date(Date.UTC(2000, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
}

export function monthShort(m: number): string {
  return new Date(Date.UTC(2000, m - 1, 1)).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
}

/** "Thu, Nov 6" */
export function shortLabel(day: Day): string {
  return utc(day).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Weekday of the 1st (0 = Sunday) and number of days in the month. */
export function monthShape(y: number, m: number): { firstWeekday: number; length: number } {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const length = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { firstWeekday: first, length };
}

/** Relative wording for nearby days, otherwise a short date. */
export function relativeLabel(day: Day, today: Day): string {
  const diff = daysBetween(today, day);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return shortLabel(day);
}
