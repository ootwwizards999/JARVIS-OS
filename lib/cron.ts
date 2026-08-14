/**
 * Cron schedule helpers for agent jobs. Definitions are stored in SQLite and
 * displayed here; the actual runner lands with the dedicated host deployment — the
 * OS is honest about that in the UI.
 */
// One comma-separated token: `*`, `*/n`, `a`, `a/n`, `a-b`, or `a-b/n` — the
// exact grammar `tokenMatches` below can evaluate. A prior looser regex
// (`[0-9*/,-]+`) accepted syntax the matcher couldn't honour — comma lists,
// `7`-as-Sunday, and step-offset were the first three instances of that gap
// (LCI-5 review round 1, F3); `a-b/n` was the fourth (round 2, C5). Validator
// and matcher must agree on syntax, or a schedule can validate and silently
// never fire. (Out-of-range *values*, e.g. minute `61`, are intentionally
// still accepted here — `tokenMatches`/`fieldMatches` range-check at match
// time and simply never match; see tests/cron-match.test.ts.)
const TOKEN_RE = /^(\*(\/\d+)?|\d+(\/\d+)?|\d+-\d+(\/\d+)?)$/;

export function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => f.split(',').every((token) => TOKEN_RE.test(token)));
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
  // A range with a step (e.g. `9-17/2`) steps from the range's own start, not
  // from `min` — `isValidCron`'s grammar accepted this syntax without the
  // matcher honouring it, so `0 9-17/2 * * *` validated and silently never
  // fired (LCI-5 review round 2, C5).
  const rangeStep = token.match(/^(\d+)-(\d+)\/(\d+)$/);
  if (rangeStep) {
    const [a, b, n] = [Number(rangeStep[1]), Number(rangeStep[2]), Number(rangeStep[3])];
    return n > 0 && a <= b && b <= max && value >= a && value <= b && (value - a) % n === 0;
  }
  const range = token.match(/^(\d+)-(\d+)$/);
  if (range) {
    const [a, b] = [Number(range[1]), Number(range[2])];
    return a <= b && b <= max && value >= a && value <= b;
  }
  // A bare value with a step (e.g. `5/15`) steps from that value, not from
  // `min` — standard cron syntax, and syntactically indistinguishable from
  // digits-and-slash under the old validator regex (LCI-5 review round 2,
  // C5 audit).
  const valueStep = token.match(/^(\d+)\/(\d+)$/);
  if (valueStep) {
    const [a, n] = [Number(valueStep[1]), Number(valueStep[2])];
    return n > 0 && a <= max && value >= a && (value - a) % n === 0;
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
