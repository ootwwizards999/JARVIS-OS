/**
 * Cron schedule helpers for agent jobs. Definitions are stored in SQLite and
 * displayed here; the actual runner lands with the dedicated host deployment — the
 * OS is honest about that in the UI.
 */
const FIELD_RE = /^(\*|[0-9*/,-]+)$/;

export function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => FIELD_RE.test(f) && !/[a-z]/i.test(f));
}

/**
 * True if `value` satisfies a single cron token (one comma-separated item):
 * `*`, `N`, a step (`*` slash `n`), or an `a-b` range. `min` is the field's
 * lowest valid value (0 for minute/hour/day-of-week, 1 for day-of-month/
 * month) — standard cron steps the range from its START, not from 0, so a
 * step on a 1-based field (e.g. `*` slash `2` on day-of-month) has to offset
 * against `min` or it lands on the wrong days (LCI-5 review round 1, F3).
 */
function tokenMatches(token: string, value: number, min: number, max: number): boolean {
  if (token === '*') return true;
  const step = token.match(/^\*\/(\d+)$/);
  if (step) {
    const n = Number(step[1]);
    return n > 0 && (value - min) % n === 0;
  }
  const range = token.match(/^(\d+)-(\d+)$/);
  if (range) {
    const [a, b] = [Number(range[1]), Number(range[2])];
    return a <= b && b <= max && value >= a && value <= b;
  }
  if (/^\d+$/.test(token)) {
    const n = Number(token);
    return n <= max && n === value;
  }
  return false;
}

/**
 * True if `value` satisfies a cron field. `isValidCron` accepts
 * comma-separated lists (e.g. `0,30`) — a field matches if `value` satisfies
 * ANY comma-separated token (LCI-5 review round 1, F3: these used to be
 * accepted by validation but silently never matched here).
 */
function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  return field.split(',').some((token) => tokenMatches(token, value, min, max));
}

/**
 * Standard 5-field cron match at minute granularity — seconds are ignored.
 * Invalid expressions (wrong field count, non-cron syntax, out-of-range
 * values) never throw; they simply never match.
 */
export function matchesCron(expr: string, at: Date): boolean {
  if (!isValidCron(expr)) return false;
  const [min, hour, dom, month, dowRaw] = expr.trim().split(/\s+/);
  // Standard cron allows both 0 and 7 for Sunday in the day-of-week field;
  // JS Date#getDay() only ever returns 0-6. Normalize whole-token 7s to 0 so
  // a schedule written with 7 still matches a real Sunday (LCI-5 review
  // round 1, F3).
  const dow = dowRaw
    .split(',')
    .map((token) => (token === '7' ? '0' : token))
    .join(',');
  return (
    fieldMatches(min, at.getMinutes(), 0, 59) &&
    fieldMatches(hour, at.getHours(), 0, 23) &&
    fieldMatches(dom, at.getDate(), 1, 31) &&
    fieldMatches(month, at.getMonth() + 1, 1, 12) &&
    fieldMatches(dow, at.getDay(), 0, 6)
  );
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dowLabel(field: string): string | null {
  if (field === '*') return 'daily';
  const range = field.match(/^(\d)-(\d)$/);
  if (range) {
    const [a, b] = [Number(range[1]), Number(range[2])];
    if (a <= 6 && b <= 6) return `${DOW[a]}–${DOW[b]}`;
  }
  if (/^\d$/.test(field) && Number(field) <= 6) return DOW[Number(field)];
  return field; // comma lists etc. shown raw
}

/** Human-readable summary, or null if the expression is not 5 valid fields. */
export function describeCron(expr: string): string | null {
  if (!isValidCron(expr)) return null;
  const [min, hour, , , dow] = expr.trim().split(/\s+/);

  const every = min.match(/^\*\/(\d+)$/);
  if (every && hour === '*') return `every ${every[1]} min`;

  if (/^\d+$/.test(min) && hour === '*') return `hourly at :${min.padStart(2, '0')}`;

  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    return `at ${time}, ${dowLabel(dow)}`;
  }

  return `cron ${expr}`;
}
