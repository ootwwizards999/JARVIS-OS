import { afterEach, describe, expect, test } from 'vitest';
import { openDb, type FounderDb } from '@/lib/db';
import { resolveAgentLane } from '@/lib/agents/lanes';
import { planTick } from '@/lib/agents/scheduler';

let db: FounderDb;

afterEach(() => {
  db?.close();
});

// 10:05 local — matches the `*/5 * * * *` fixture cron.
const AT = new Date('2026-08-13T10:05:00');

const UNKNOWN_AGENT = 'agent-never-registered';

type RunRow = Parameters<FounderDb['agentRuns']['insert']>[0];

/** A foreign in-flight run consuming no-build capacity (extended LCI-5 shape). */
function runningNoBuild(id: string): RunRow {
  const row = {
    id,
    agentId: `other-${id}`,
    startedAt: '2026-08-13T09:00:00.000Z', // not in AT's minute — never suppresses
    finishedAt: null,
    ok: false,
    summary: '',
    status: 'running',
    lane: 'no-build',
    decisionType: 'ticket.triage',
    cronId: null,
  };
  return row as unknown as RunRow;
}

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

describe('fail-safe defaults hold on the real dispatch path (planTick → governor)', () => {
  // A registry that returns safe values but is never consulted — or one that
  // falls open to a permissive lane — cannot pass these: the unknown agent
  // must be governed under the no-build cap (6), not build-light/build-heavy
  // and not skipped.

  test('an unknown agent is governed as no-build: DENIED when the no-build lane is saturated', () => {
    db = openDb(':memory:');
    for (let i = 0; i < 6; i++) db.agentRuns.insert(runningNoBuild(`nb-${i}`));
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

  test('an unknown agent stays dispatchable under the safest defaults when the lane has room', () => {
    // Safest, not skipped: with one no-build slot free, the unknown agent's
    // cron is planned and permitted — proving the denial above is the lane
    // cap doing its job, not the registry dropping unregistered agents.
    db = openDb(':memory:');
    for (let i = 0; i < 5; i++) db.agentRuns.insert(runningNoBuild(`nb-${i}`));
    unknownAgentCron(db);

    const decisions = planTick(db, AT);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      agentId: UNKNOWN_AGENT,
      lane: 'no-build',
      permitted: true,
    });
  });
});
