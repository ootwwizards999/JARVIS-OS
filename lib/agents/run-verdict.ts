/**
 * Single source of truth for "what should this run render as" (LCI-5 review
 * round 4). A scheduler claim is written with `status: 'running'` and a
 * placeholder `ok: false` before its worker reports back (lib/agents/scheduler.ts)
 * — that placeholder is not a failure, it's in-flight. Every call site that used
 * to derive its own `r.ok ? 'OK' : 'FAIL'` re-implemented this distinction, and
 * every fix round (1, 3, 4) missed a surface that hadn't been touched yet: the
 * roster card, the analytics pie, the harness/KG/Neural cards, the /agents
 * activity feed, and now three more in app/page.tsx. The fix is structural, not
 * another patched call site — one helper, every reader routes through it.
 *
 * `status` is optional because completed runs written by the manual-trigger
 * path (lib/agents/runtime.ts) never set it — the DB layer defaults it to
 * `'ok'` at the write boundary (lib/db.ts). Only the literal `'running'` is
 * special-cased here; any other status value (including a stale/mislabeled one)
 * still falls through to the `ok` field, so a released claim with `ok: false`
 * is always `'failed'` regardless of what its `status` column says.
 */
export type RunVerdict = 'running' | 'ok' | 'failed';

export function runVerdict(run: { status?: string; ok: boolean }): RunVerdict {
  if (run.status === 'running') return 'running';
  return run.ok ? 'ok' : 'failed';
}

/** True only for a run that actually failed — never for one still in flight. */
export function isFailedRun(run: { status?: string; ok: boolean }): boolean {
  return runVerdict(run) === 'failed';
}
