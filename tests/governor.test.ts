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
  };
  d.agentRuns.insert(row as unknown as RunRow);
}

// Autonomy levels are numeric: L1 = 1 … L5 = 5.
function request(overrides: Partial<{ agentId: string; lane: string; decisionType: string; autonomy: number }>) {
  return {
    agentId: 'spiritguide-web',
    lane: 'no-build',
    decisionType: 'ticket.triage',
    autonomy: 1,
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
    const decision = evaluateDispatch(db, request({ lane: 'no-build', decisionType: 'ticket.triage', autonomy: 1 }));
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
    const below = evaluateDispatch(db, request({ lane, autonomy: 1, decisionType: 'ticket.triage' }));
    expect(below.permitted).toBe(true);

    insertRun(db, { id: `r${cap - 1}`, lane });
    const atCap = evaluateDispatch(db, request({ lane, autonomy: 1, decisionType: 'ticket.triage' }));
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

describe('governor — autonomy ceilings', () => {
  test.each([2, 3, 4])('denies merge.arm at autonomy L%i with a reason', (autonomy) => {
    db = openDb(':memory:');
    const decision = evaluateDispatch(db, request({ decisionType: 'merge.arm', autonomy }));
    expect(decision.permitted).toBe(false);
    expect(typeof decision.reason).toBe('string');
    expect(decision.reason).not.toBe('');
  });

  test('permits merge.arm at L1', () => {
    db = openDb(':memory:');
    const decision = evaluateDispatch(db, request({ decisionType: 'merge.arm', autonomy: 1 }));
    expect(decision.permitted).toBe(true);
  });

  test('permits ticket.triage at L4', () => {
    db = openDb(':memory:');
    const decision = evaluateDispatch(db, request({ decisionType: 'ticket.triage', autonomy: 4 }));
    expect(decision.permitted).toBe(true);
  });

  // decision type -> ceiling, straight from the spec table.
  const ceilings = [
    { decisionType: 'ticket.triage', ceiling: 4 },
    { decisionType: 'code.implement', ceiling: 3 },
    { decisionType: 'code.review', ceiling: 3 },
    { decisionType: 'merge.arm', ceiling: 1 },
    { decisionType: 'schema.migrate', ceiling: 1 },
    { decisionType: 'payments.touch', ceiling: 1 },
    { decisionType: 'compliance.copy', ceiling: 1 },
  ] as const;

  test.each(ceilings)('$decisionType: permits at L$ceiling, denies above', ({ decisionType, ceiling }) => {
    db = openDb(':memory:');
    const atCeiling = evaluateDispatch(db, request({ decisionType, autonomy: ceiling }));
    expect(atCeiling.permitted).toBe(true);

    const above = evaluateDispatch(db, request({ decisionType, autonomy: ceiling + 1 }));
    expect(above.permitted).toBe(false);
    expect(typeof above.reason).toBe('string');
    expect(above.reason).not.toBe('');
  });
});
