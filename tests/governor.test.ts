import { afterEach, describe, expect, test } from 'vitest';
import { openDb, type FounderDb } from '@/lib/db';
import { evaluateDispatch } from '@/lib/agents/governor';

let db: FounderDb;

afterEach(() => {
  db?.close();
});

type RunRow = Parameters<FounderDb['agentRuns']['insert']>[0];

/**
 * Insert an agent_runs row in the extended LCI-5 shape. `status` defaults to
 * 'running' (the shape the governor counts); finished runs get a finishedAt.
 * The cast keeps this file compiling against the pre-migration AgentRun type;
 * the repo's Zod parse enforces the real shape at runtime.
 */
function insertRun(
  d: FounderDb,
  opts: { id: string; lane: string; agentId?: string; status?: 'running' | 'ok' },
) {
  const status = opts.status ?? 'running';
  const row = {
    id: opts.id,
    agentId: opts.agentId ?? `agent-${opts.id}`,
    startedAt: '2026-08-13T09:00:00.000Z',
    finishedAt: status === 'running' ? null : '2026-08-13T09:03:00.000Z',
    ok: status !== 'running',
    summary: '',
    status,
    lane: opts.lane,
    decisionType: 'code.implement',
    cronId: null,
  };
  d.agentRuns.insert(row as unknown as RunRow);
}

// Autonomy levels are numeric: L1 = 1 … L5 = 5 (L5 reserved, unimplemented).
// Default request passes the autonomy guards (ticket.triage requires 2) so the
// lane tests below isolate lane concurrency.
function request(overrides: Partial<{ agentId: string; lane: string; decisionType: string; autonomy: number }>) {
  return {
    agentId: 'spiritguide-web',
    lane: 'no-build',
    decisionType: 'ticket.triage',
    autonomy: 2,
    ...overrides,
  };
}

describe('governor — lane concurrency caps', () => {
  test("denies a 2nd build-heavy dispatch while one run has status='running'", () => {
    db = openDb(':memory:');
    insertRun(db, { id: 'r1', lane: 'build-heavy' });
    const decision = evaluateDispatch(db, request({ lane: 'build-heavy', decisionType: 'code.implement', autonomy: 3 }));
    expect(decision.permitted).toBe(false);
    expect(typeof decision.reason).toBe('string');
    expect(decision.reason).not.toBe('');
  });

  test('permits a 4th no-build dispatch while three are running', () => {
    db = openDb(':memory:');
    insertRun(db, { id: 'r1', lane: 'no-build' });
    insertRun(db, { id: 'r2', lane: 'no-build' });
    insertRun(db, { id: 'r3', lane: 'no-build' });
    const decision = evaluateDispatch(db, request({ lane: 'no-build', decisionType: 'ticket.triage', autonomy: 2 }));
    expect(decision.permitted).toBe(true);
  });

  const laneCaps = [
    { lane: 'build-heavy', cap: 1 },
    { lane: 'build-light', cap: 3 },
    { lane: 'no-build', cap: 6 },
  ] as const;

  test.each(laneCaps)('$lane: permits at $cap-1 running, denies at $cap running', ({ lane, cap }) => {
    db = openDb(':memory:');
    for (let i = 0; i < cap - 1; i++) insertRun(db, { id: `r${i}`, lane });
    const below = evaluateDispatch(db, request({ lane, autonomy: 2, decisionType: 'ticket.triage' }));
    expect(below.permitted).toBe(true);

    insertRun(db, { id: `r${cap - 1}`, lane });
    const atCap = evaluateDispatch(db, request({ lane, autonomy: 2, decisionType: 'ticket.triage' }));
    expect(atCap.permitted).toBe(false);
    expect(typeof atCap.reason).toBe('string');
    expect(atCap.reason).not.toBe('');
  });

  test('finished runs do not consume lane capacity', () => {
    db = openDb(':memory:');
    for (let i = 0; i < 5; i++) insertRun(db, { id: `done-${i}`, lane: 'build-heavy', status: 'ok' });
    const decision = evaluateDispatch(db, request({ lane: 'build-heavy', decisionType: 'code.implement', autonomy: 3 }));
    expect(decision.permitted).toBe(true);
  });

  test('running runs in OTHER lanes do not consume this lane', () => {
    db = openDb(':memory:');
    insertRun(db, { id: 'r-light', lane: 'build-light' });
    insertRun(db, { id: 'r-none', lane: 'no-build' });
    const decision = evaluateDispatch(db, request({ lane: 'build-heavy', decisionType: 'code.implement', autonomy: 3 }));
    expect(decision.permitted).toBe(true);
  });
});

describe('governor — autonomy model (requires + ceiling, both guards must pass)', () => {
  // permitted iff requires <= ceiling AND agent.autonomy >= requires.
  // Table verbatim from the spec ("Autonomy model — CORRECTED AND LOCKED").
  const decisionPolicy = [
    { decisionType: 'ticket.triage', requires: 2, ceiling: 4 },
    { decisionType: 'code.review', requires: 2, ceiling: 3 },
    { decisionType: 'code.implement', requires: 3, ceiling: 3 },
    { decisionType: 'merge.arm', requires: 4, ceiling: 1 },
    { decisionType: 'schema.migrate', requires: 4, ceiling: 1 },
    { decisionType: 'payments.touch', requires: 4, ceiling: 1 },
    { decisionType: 'compliance.copy', requires: 4, ceiling: 1 },
  ] as const;

  const allowedTypes = decisionPolicy.filter((d) => d.requires <= d.ceiling);
  const forbiddenTypes = decisionPolicy.filter((d) => d.requires > d.ceiling);

  describe('operator-allowed decision types (requires <= ceiling)', () => {
    test.each(allowedTypes)(
      '$decisionType: permits at L$requires and above, denies below with a non-empty reason',
      ({ decisionType, requires }) => {
        db = openDb(':memory:');
        // agent@requires+ permitted — the spec table's effect column, verbatim.
        expect(evaluateDispatch(db, request({ decisionType, autonomy: requires })).permitted).toBe(true);
        expect(evaluateDispatch(db, request({ decisionType, autonomy: 4 })).permitted).toBe(true);

        // Not trusted enough: one below the requirement.
        const denied = evaluateDispatch(db, request({ decisionType, autonomy: requires - 1 }));
        expect(denied.permitted).toBe(false);
        expect(typeof denied.reason).toBe('string');
        expect(denied.reason).not.toBe('');
      },
    );

    test('code.implement refuses an autonomy-1 agent (the unknown-agent fail-safe value)', () => {
      db = openDb(':memory:');
      const decision = evaluateDispatch(db, request({ decisionType: 'code.implement', autonomy: 1 }));
      expect(decision.permitted).toBe(false);
      expect(decision.reason).not.toBe('');
    });

    test('permits ticket.triage at L4', () => {
      db = openDb(':memory:');
      expect(evaluateDispatch(db, request({ decisionType: 'ticket.triage', autonomy: 4 })).permitted).toBe(true);
    });
  });

  describe('operator-forbidden decision types (requires > ceiling): denied for EVERYONE', () => {
    test.each(forbiddenTypes)(
      '$decisionType is denied at every autonomy level, including L1 and L4',
      ({ decisionType }) => {
        db = openDb(':memory:');
        for (const autonomy of [1, 2, 3, 4, 5]) {
          const decision = evaluateDispatch(db, request({ decisionType, autonomy }));
          expect(decision.permitted).toBe(false);
          expect(typeof decision.reason).toBe('string');
          expect(decision.reason).not.toBe('');
        }
      },
    );
  });

  describe('the two denial reasons are distinguishable', () => {
    test('policy-forbids reason is autonomy-invariant: merge.arm gives the SAME reason at every level', () => {
      // "Never allowed unsupervised" is a fact about the action, not the
      // agent — telling a low-autonomy agent it isn't trusted enough would
      // wrongly imply more trust could unlock it.
      db = openDb(':memory:');
      const reasons = [1, 2, 3, 4, 5].map(
        (autonomy) => evaluateDispatch(db, request({ decisionType: 'merge.arm', autonomy })).reason,
      );
      expect(reasons[0]).not.toBe('');
      for (const reason of reasons) expect(reason).toBe(reasons[0]);
    });

    test('policy-forbids and not-trusted-enough produce different reasons at the same autonomy', () => {
      db = openDb(':memory:');
      const policy = evaluateDispatch(db, request({ decisionType: 'merge.arm', autonomy: 2 }));
      const competence = evaluateDispatch(db, request({ decisionType: 'code.implement', autonomy: 2 }));
      expect(policy.permitted).toBe(false);
      expect(competence.permitted).toBe(false);
      expect(policy.reason).not.toBe('');
      expect(competence.reason).not.toBe('');
      expect(policy.reason).not.toBe(competence.reason);
    });
  });
});
