import { randomUUID } from 'node:crypto';
import type { FounderDb } from '@/lib/db';
import { resolveAgentLane } from '@/lib/agents/lanes';
import { evaluateDispatch, effectiveAutonomy, type DenialKind } from '@/lib/agents/governor';

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
  /**
   * Set only on a claimed (permitted + dispatched) decision: the exact
   * `agent_runs.id` and `startedAt` this decision claimed. Two crons for the
   * same lane can both be due in the same minute, so `agentId`/`cronId` alone
   * don't identify which claim a given worker belongs to — the spawner
   * (next ticket) needs `runId` to durably complete the right row (LCI-5
   * review round 2, C3). Undefined on denied/unclaimed decisions. `autonomy`
   * on a claimed decision is the EFFECTIVE (ceiling-capped) level, not the
   * agent's raw autonomy — see `effectiveAutonomy` (LCI-5 review round 2, C2).
   */
  runId?: string;
  startedAt?: string;
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
 * Plans, then claims every permitted decision and dispatches it. The claim
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
 *
 * `dispatch` itself runs AFTER the transaction commits, not inside it (LCI-5
 * review round 2, C4). A real detached worker opens its OWN DB connection —
 * if it were spawned from inside the still-open `BEGIN IMMEDIATE`, it could
 * start before the claim is durable, race the commit, or hit SQLITE_BUSY and
 * never record completion, wedging the lane on a permanent `running` claim.
 * Claims are collected while the transaction runs, then dispatched in a
 * second pass once it has returned (and therefore committed) — the TOCTOU
 * protection from F6 is unaffected, because claiming still happens entirely
 * inside the transaction.
 */
export function runTick(
  db: FounderDb,
  now: Date,
  dispatch: (decision: DispatchDecision) => void,
): DispatchDecision[] {
  const claimed: DispatchDecision[] = [];

  const decisions = db.transaction((): DispatchDecision[] => {
    return planTick(db, now).map((decision) => {
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

      const runId = randomUUID();
      const startedAt = now.toISOString();
      db.agentRuns.insert({
        id: runId,
        agentId: decision.agentId,
        startedAt,
        finishedAt: null,
        ok: false,
        summary: '',
        status: 'running',
        lane: decision.lane,
        decisionType: decision.decisionType,
        cronId: decision.cronId,
      });

      // Carry the EFFECTIVE (ceiling-capped) autonomy downstream, not the
      // agent's raw value — the dispatcher must never see enough authority
      // to act above the operator's ceiling for this decision type (C2).
      const claim: DispatchDecision = {
        ...decision,
        autonomy: effectiveAutonomy(decision.decisionType, decision.autonomy),
        runId,
        startedAt,
      };
      claimed.push(claim);
      return claim;
    });
  });

  for (const decision of claimed) dispatch(decision);

  return decisions;
}
