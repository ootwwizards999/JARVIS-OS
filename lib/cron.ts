/**
 * Cron schedule helpers for agent jobs. Definitions are stored in SQLite and
 * displayed here; the actual runner lands with the dedicated host deployment — the
 * OS is honest about that in the UI.
 */

/**
 * The parsed shape of ONE comma-separated cron token. This is the single
 * source of truth for cron grammar (LCI-5 review rounds 1-3, ten findings —
 * always `isValidCron` and `matchesCron` disagreeing about what a token
 * means). `isValidCron` and `tokenMatches` both call `parseToken` and ONLY
 * `parseToken` — neither re-implements the grammar. A token `parseToken`
 * rejects can never reach the matcher (isValidCron gates every call site
 * that runs `matchesCron`), and the matcher has no notion of "valid" beyond
 * "did this parse" — so validator/matcher disagreement is structurally
 * impossible, not just fixed for the currently-known cases.
 */
type ParsedToken =
  | { kind: 'star' }
  | { kind: 'star-step'; step: number }
  | { kind: 'value'; value: number }
  | { kind: 'value-step'; value: number; step: number }
  | { kind: 'range'; from: number; to: number }
  | { kind: 'range-step'; from: number; to: number; step: number };

/**
 * Parses one comma-separated cron token (`*`, `*` slash `n`, `a`, `a/n`,
 * `a-b`, or `a-b/n`) into its structured form, or `null` if it is not valid cron
 * syntax. Deliberately field-agnostic: this enforces grammar SHAPE and
 * structural sanity (a step must be `> 0`; a range must not be reversed,
 * `a <= b`) but NOT per-field value bounds (e.g. minute `0-59`) — those are
 * intentionally deferred to match time. See tests/cron-match.test.ts: an
 * out-of-range value like minute `61` is syntactically valid and simply
 * never matches; that behavior is preserved here on purpose (LCI-5 review
 * round 4).
 */
function parseToken(token: string): ParsedToken | null {
  if (token === '*') return { kind: 'star' };

  const starStep = token.match(/^\*\/(\d+)$/);
  if (starStep) {
    const step = Number(starStep[1]);
    return step > 0 ? { kind: 'star-step', step } : null;
  }

  const rangeStep = token.match(/^(\d+)-(\d+)\/(\d+)$/);
  if (rangeStep) {
    const [from, to, step] = [Number(rangeStep[1]), Number(rangeStep[2]), Number(rangeStep[3])];
    return step > 0 && from <= to ? { kind: 'range-step', from, to, step } : null;
  }

  const range = token.match(/^(\d+)-(\d+)$/);
  if (range) {
    const [from, to] = [Number(range[1]), Number(range[2])];
    return from <= to ? { kind: 'range', from, to } : null;
  }

  const valueStep = token.match(/^(\d+)\/(\d+)$/);
  if (valueStep) {
    const [value, step] = [Number(valueStep[1]), Number(valueStep[2])];
    return step > 0 ? { kind: 'value-step', value, step } : null;
  }

  if (/^\d+$/.test(token)) return { kind: 'value', value: Number(token) };

  return null;
}

export function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => f.split(',').every((token) => parseToken(token) !== null));
}

/**
 * True if `value` satisfies a single cron token, using the SAME parse
 * `isValidCron` used to decide the token was legal — see `parseToken`.
 * `min` is the field's lowest valid value (0 for minute/hour/day-of-week, 1
 * for day-of-month/month):
 *  - a step (`*` slash `n`) offsets from `min`, not from 0 — standard cron
 *    steps a 1-based field from its own start (LCI-5 review round 1, F3).
 *  - a range/range-step is enforced against BOTH `min` and `max` on its own
 *    endpoints, not just `max` — a range whose lower bound is below the
 *    field's minimum (e.g. day-of-month `0-2`, since day-of-month has no
 *    day 0) can never legitimately match anything, matching the "invalid
 *    values never match" philosophy above rather than silently firing on
 *    the in-range remainder of the token (LCI-5 review round 3: `0-2`
 *    fired on the 1st and 2nd because only the upper bound was checked).
 */
function tokenMatches(token: string, value: number, min: number, max: number): boolean {
  const parsed = parseToken(token);
  if (!parsed) return false;

  switch (parsed.kind) {
    case 'star':
      return true;
    case 'star-step':
      return (value - min) % parsed.step === 0;
    case 'value':
      return parsed.value >= min && parsed.value <= max && parsed.value === value;
    case 'value-step':
      return (
        parsed.value >= min &&
        parsed.value <= max &&
        value >= parsed.value &&
        (value - parsed.value) % parsed.step === 0
      );
    case 'range':
      return parsed.from >= min && parsed.to <= max && value >= parsed.from && value <= parsed.to;
    case 'range-step':
      return (
        parsed.from >= min &&
        parsed.to <= max &&
        value >= parsed.from &&
        value <= parsed.to &&
        (value - parsed.from) % parsed.step === 0
      );
  }
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
  const [min, hour, dom, month, dow] = expr.trim().split(/\s+/);
  const day = at.getDay(); // JS convention: 0-6, Sunday = 0

  // Standard cron allows both 0 and 7 for Sunday in the day-of-week field.
  // The alias can appear anywhere a value can — a bare `7`, inside a range
  // (`5-7`), or with a step (`7/2`, `1-7/2`) — so instead of rewriting
  // tokens (which only ever caught the bare-`7` case), the field's own
  // upper bound is 7, not 6, and a real Sunday (day === 0) is checked
  // against BOTH its JS value and its cron alias. `5-7` (Fri-Sun) and
  // `0-7` (every day, standard and legal) previously validated and then
  // silently never matched (LCI-5 review round 3).
  const dowMatches = fieldMatches(dow, day, 0, 7) || (day === 0 && fieldMatches(dow, 7, 0, 7));

  return (
    fieldMatches(min, at.getMinutes(), 0, 59) &&
    fieldMatches(hour, at.getHours(), 0, 23) &&
    fieldMatches(dom, at.getDate(), 1, 31) &&
    fieldMatches(month, at.getMonth() + 1, 1, 12) &&
    dowMatches
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
