import type { FounderDb } from '@/lib/db';

/**
 * Dispatch governor (LCI-5). Pure — reads lane concurrency from the DB,
 * writes nothing.
 *
 * Two independent guards, both must pass:
 *   requires <= ceiling          operator policy: is this ever allowed unsupervised?
 *   agent.autonomy >= requires   competence: is this agent trusted enough?
 * When both fail, `kind` is 'policy' — a low-autonomy agent must never be
 * told that more trust would unlock a permanently forbidden action.
 *
 * A third, independent check — lane concurrency — only runs once both
 * autonomy guards pass. Its denial `kind` is 'capacity': transient, and it
 * self-resolves on a later tick once a running job in that lane finishes.
 */

const LANE_CAPS: Record<string, number> = {
  'build-heavy': 1,
  'build-light': 3,
  'no-build': 6,
};

const DECISION_POLICY: Record<string, { requires: number; ceiling: number }> = {
  'ticket.triage': { requires: 2, ceiling: 4 },
  'code.review': { requires: 2, ceiling: 3 },
  'code.implement': { requires: 3, ceiling: 3 },
  'merge.arm': { requires: 4, ceiling: 1 },
  'schema.migrate': { requires: 4, ceiling: 1 },
  'payments.touch': { requires: 4, ceiling: 1 },
  'compliance.copy': { requires: 4, ceiling: 1 },
};

export type DispatchRequest = {
  agentId: string;
  lane: string;
  decisionType: string;
  autonomy: number;
};

export type DenialKind = 'policy' | 'competence' | 'capacity';

export type DispatchDecision = {
  permitted: boolean;
  kind?: DenialKind;
  reason: string;
};

export function evaluateDispatch(db: FounderDb, req: DispatchRequest): DispatchDecision {
  const policy = DECISION_POLICY[req.decisionType];
  if (!policy) {
    return { permitted: false, kind: 'policy', reason: `unknown decision type: ${req.decisionType}` };
  }

  if (policy.requires > policy.ceiling) {
    return {
      permitted: false,
      kind: 'policy',
      reason: `${req.decisionType} is never permitted unsupervised (requires L${policy.requires}, operator ceiling L${policy.ceiling})`,
    };
  }

  if (req.autonomy < policy.requires) {
    return {
      permitted: false,
      kind: 'competence',
      reason: `${req.agentId} is autonomy L${req.autonomy}; ${req.decisionType} requires L${policy.requires}`,
    };
  }

  // Fail CLOSED: a lane with no capacity policy gets no capacity, not
  // unlimited capacity. `evaluateDispatch` is exported and takes an
  // arbitrary `lane` string; only `resolveAgentLane`'s three known lanes are
  // reachable today, but an unrecognized one must never bypass the gate
  // (LCI-5 review round 1, F8).
  const cap = LANE_CAPS[req.lane];
  if (cap === undefined) {
    return { permitted: false, kind: 'policy', reason: `unknown lane: ${req.lane} has no capacity policy defined` };
  }

  const running = db.agentRuns.runningInLane(req.lane);
  if (running >= cap) {
    return {
      permitted: false,
      kind: 'capacity',
      reason: `lane ${req.lane} is at capacity (${running}/${cap} running) — retry next tick`,
    };
  }

  return { permitted: true, reason: '' };
}
