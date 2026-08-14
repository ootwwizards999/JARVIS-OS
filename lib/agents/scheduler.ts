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
 */
export function runTick(
  db: FounderDb,
  now: Date,
  dispatch: (decision: DispatchDecision) => void,
): DispatchDecision[] {
  const decisions = planTick(db, now);
  for (const decision of decisions) {
    if (!decision.permitted) continue;
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
  }
  return decisions;
}
