import { randomUUID } from 'node:crypto';
import type { FounderDb } from '@/lib/db';
import { resolveAgentLane } from '@/lib/agents/lanes';
import { evaluateDispatch, type DenialKind } from '@/lib/agents/governor';

/**
 * Tick engine (LCI-5). Thin tick + detached workers: `planTick` decides,
 * `runTick` claims and fires the injected dispatcher. No long-lived
 * supervisor, no in-Next setInterval — see the spec's "Dispatch model".
 */
export type DispatchDecision = {
  agentId: string;
  cronId: string;
  lane: string;
  decisionType: string;
  autonomy: number;
  permitted: boolean;
  kind?: DenialKind;
  reason: string;
};

/** Pure: decides what a tick at `now` would do. Writes nothing. */
export function planTick(db: FounderDb, now: Date): DispatchDecision[] {
  return db.agentCrons.dueNow(now).map((cron) => {
    const resolved = resolveAgentLane(cron.agentId);
    const evaluation = evaluateDispatch(db, {
      agentId: cron.agentId,
      lane: resolved.lane,
      decisionType: resolved.decisionType,
      autonomy: resolved.autonomy,
    });
    return {
      agentId: cron.agentId,
      cronId: cron.id,
      lane: resolved.lane,
      decisionType: resolved.decisionType,
      autonomy: resolved.autonomy,
      permitted: evaluation.permitted,
      kind: evaluation.kind,
      reason: evaluation.reason,
    };
  });
}

/**
 * Plans, then claims and dispatches every permitted decision. The claim
 * (status='running', finishedAt=null) is written BEFORE `dispatch` is
 * called, so a replay of the same tick minute sees it via `dueNow` and skips
 * it — that's what makes the tick idempotent to retry. `dispatch` is never
 * awaited: the caller (the route) must not block on worker completion.
 *
 * `planTick` decides everything against one pre-tick snapshot, so several
 * crons for the same capped lane can all come back permitted — none of them
 * has seen the others' claims yet. Before claiming each one, re-run the
 * capacity check against the DB's CURRENT state: because each claim is
 * inserted on this same connection before moving to the next decision, a
 * lane's running count already reflects every claim made earlier in THIS
 * tick by the time the next decision is rechecked — no separate tally
 * needed. A decision that no longer fits flips to denied here instead of
 * being claimed (LCI-5 review round 1, F1). The whole plan+claim sequence
 * runs inside one `BEGIN IMMEDIATE` transaction so a second process ticking
 * concurrently against the same DB file can't interleave with it either
 * (F6) — it blocks (via `busy_timeout`) until this tick commits, then plans
 * against the post-commit state.
 */
export function runTick(
  db: FounderDb,
  now: Date,
  dispatch: (decision: DispatchDecision) => void,
): DispatchDecision[] {
  return db.transaction((): DispatchDecision[] => {
    const decisions = planTick(db, now);
    return decisions.map((decision) => {
      if (!decision.permitted) return decision;

      const recheck = evaluateDispatch(db, {
        agentId: decision.agentId,
        lane: decision.lane,
        decisionType: decision.decisionType,
        autonomy: decision.autonomy,
      });
      if (!recheck.permitted) {
        return { ...decision, permitted: false, kind: recheck.kind, reason: recheck.reason };
      }

      db.agentRuns.insert({
        id: randomUUID(),
        agentId: decision.agentId,
        startedAt: now.toISOString(),
        finishedAt: null,
        ok: false,
        summary: '',
        status: 'running',
        lane: decision.lane,
        decisionType: decision.decisionType,
        cronId: decision.cronId,
      });
      dispatch(decision);
      return decision;
    });
  });
}
