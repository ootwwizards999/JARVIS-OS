import { afterEach, describe, expect, test } from 'vitest';
import { openDb, type FounderDb } from '@/lib/db';
import { resolveAgentLane } from '@/lib/agents/lanes';
import { evaluateDispatch } from '@/lib/agents/governor';
import { planTick } from '@/lib/agents/scheduler';

let db: FounderDb;

afterEach(() => {
  db?.close();
});

// 10:05 local — matches the `*/5 * * * *` fixture cron.
const AT = new Date('2026-08-13T10:05:00');

const UNKNOWN_AGENT = 'agent-never-registered';

function unknownAgentCron(d: FounderDb) {
  d.agentCrons.insert({
    id: 'cron-unknown',
    agentId: UNKNOWN_AGENT,
    schedule: '*/5 * * * *',
    description: 'cron for an agent nobody registered',
    enabled: true,
    createdAt: '2026-08-01T00:00:00.000Z',
  });
}

describe('lanes registry — fail-safe resolution', () => {
  // A wrongly permissive default passes every other test in the suite, so the
  // safest values are pinned by exact value here (spec round-2 item 10).
  test.each([
    UNKNOWN_AGENT,
    'spiritguide-ios', // plausible-looking, but not registered in this ticket
    '', // empty string
  ])('unregistered agent id %j resolves to exactly { lane: no-build, autonomy: 1 }', (agentId) => {
    const resolved = resolveAgentLane(agentId);
    expect(resolved.lane).toBe('no-build');
    expect(resolved.autonomy).toBe(1);
  });

  test('undefined agent id never throws and resolves to the same safest values', () => {
    const call = () => resolveAgentLane(undefined as unknown as string);
    expect(call).not.toThrow();
    const resolved = call();
    expect(resolved.lane).toBe('no-build');
    expect(resolved.autonomy).toBe(1);
  });

  test('the one mapping acceptance names: spiritguide-web resolves to build-light', () => {
    expect(resolveAgentLane('spiritguide-web').lane).toBe('build-light');
  });
});

describe('fail-safe defaults hold on the real dispatch path (registry → governor)', () => {
  // A registry that returns safe values but is never consulted cannot pass
  // these: the resolved values flow into the gate, and under the corrected
  // autonomy model (requires + ceiling) autonomy 1 is refused everything.

  test('end-to-end: an unknown agent attempting code.implement is DENIED, as not-trusted-enough', () => {
    db = openDb(':memory:');
    const resolved = resolveAgentLane(UNKNOWN_AGENT);

    const decision = evaluateDispatch(db, {
      agentId: UNKNOWN_AGENT,
      lane: resolved.lane,
      decisionType: 'code.implement',
      autonomy: resolved.autonomy,
    });
    expect(decision.permitted).toBe(false);
    expect(typeof decision.reason).toBe('string');
    expect(decision.reason).not.toBe('');

    // Specifically the not-trusted-enough denial, not the policy one: the
    // reason must differ from a policy-forbidden denial for the same agent.
    const policyDenied = evaluateDispatch(db, {
      agentId: UNKNOWN_AGENT,
      lane: resolved.lane,
      decisionType: 'merge.arm',
      autonomy: resolved.autonomy,
    });
    expect(policyDenied.permitted).toBe(false);
    expect(decision.reason).not.toBe(policyDenied.reason);
  });

  test("planTick refuses an unknown agent's cron on the no-build lane — never silently drops it", () => {
    // Refused, not skipped: the decision must surface (with the resolved
    // safest lane) so the denial is visible in {denied, reasons}, rather
    // than the cron vanishing from the tick.
    db = openDb(':memory:');
    unknownAgentCron(db);

    const decisions = planTick(db, AT);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      agentId: UNKNOWN_AGENT,
      lane: 'no-build',
      permitted: false,
    });
    expect(typeof decisions[0].reason).toBe('string');
    expect(decisions[0].reason).not.toBe('');
  });
});
