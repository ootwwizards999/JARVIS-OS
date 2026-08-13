import { afterEach, describe, expect, test } from 'vitest';
import { openDb, type FounderDb } from '@/lib/db';
import type { AgentCron } from '@/lib/schemas';

let db: FounderDb;

afterEach(() => {
  db?.close();
});

// 10:05 local — matches `*/5 * * * *`, does not match `0 2 * * *`.
const AT = new Date('2026-08-13T10:05:00');

function cron(overrides: Partial<AgentCron> & { id: string }): AgentCron {
  return {
    agentId: 'spiritguide-web',
    schedule: '*/5 * * * *',
    description: 'tick worker',
    enabled: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

type RunRow = Parameters<FounderDb['agentRuns']['insert']>[0];

/**
 * A run started `deltaSeconds` from AT, claimed for `cronId`. Uses the
 * extended agent_runs shape from the LCI-5 schema change (status / lane /
 * decisionType / cronId, nullable finishedAt). dueNow suppression keys on
 * cron_id + minute (spec gap resolution #2). The cast keeps this file
 * compiling against the pre-migration AgentRun type; at runtime the repo's
 * own Zod parse enforces the real shape.
 */
function run(
  id: string,
  agentId: string,
  cronId: string | null,
  deltaSeconds: number,
  opts?: { finished?: boolean },
): RunRow {
  const startedAt = new Date(AT.getTime() + deltaSeconds * 1000).toISOString();
  const finished = opts?.finished ?? false;
  const row = {
    id,
    agentId,
    startedAt,
    finishedAt: finished ? new Date(AT.getTime() + deltaSeconds * 1000 + 5000).toISOString() : null,
    ok: finished,
    summary: '',
    status: finished ? 'ok' : 'running',
    lane: 'build-light',
    decisionType: 'code.implement',
    cronId,
  };
  return row as unknown as RunRow;
}

describe('agentCrons.dueNow', () => {
  test('returns an enabled cron whose schedule matches the given minute', () => {
    db = openDb(':memory:');
    const c = cron({ id: 'c-due' });
    db.agentCrons.insert(c);
    const due = db.agentCrons.dueNow(AT);
    expect(due.map((d) => d.id)).toEqual(['c-due']);
    expect(due[0]).toMatchObject({
      id: 'c-due',
      agentId: 'spiritguide-web',
      schedule: '*/5 * * * *',
      enabled: true,
    });
  });

  test('does not return a disabled cron even when its schedule matches', () => {
    db = openDb(':memory:');
    db.agentCrons.insert(cron({ id: 'c-off', enabled: false }));
    expect(db.agentCrons.dueNow(AT)).toEqual([]);
  });

  test('does not return a cron whose schedule does not match the minute', () => {
    db = openDb(':memory:');
    db.agentCrons.insert(cron({ id: 'c-2am', schedule: '0 2 * * *' }));
    expect(db.agentCrons.dueNow(AT)).toEqual([]);
  });

  test('filters per-cron: only the matching, enabled crons come back', () => {
    db = openDb(':memory:');
    db.agentCrons.insert(cron({ id: 'c-due' }));
    db.agentCrons.insert(cron({ id: 'c-off', agentId: 'other-agent', enabled: false }));
    db.agentCrons.insert(cron({ id: 'c-2am', agentId: 'third-agent', schedule: '0 2 * * *' }));
    expect(db.agentCrons.dueNow(AT).map((d) => d.id)).toEqual(['c-due']);
  });

  describe('idempotency — a cron already dispatched in the same minute is not returned again', () => {
    test('an in-flight run (status=running) claimed for this cron in the same minute suppresses it', () => {
      db = openDb(':memory:');
      db.agentCrons.insert(cron({ id: 'c-due' }));
      // Claim row written by a previous replay of this exact tick, 20s in.
      db.agentRuns.insert(run('r-claim', 'spiritguide-web', 'c-due', 20));
      expect(db.agentCrons.dueNow(AT)).toEqual([]);
    });

    test("a run for this cron that already finished within the same minute still suppresses it", () => {
      db = openDb(':memory:');
      db.agentCrons.insert(cron({ id: 'c-due' }));
      db.agentRuns.insert(run('r-done', 'spiritguide-web', 'c-due', 10, { finished: true }));
      expect(db.agentCrons.dueNow(AT)).toEqual([]);
    });

    test('a run for this cron started in the PREVIOUS minute does not suppress it', () => {
      db = openDb(':memory:');
      db.agentCrons.insert(cron({ id: 'c-due' }));
      db.agentRuns.insert(run('r-old', 'spiritguide-web', 'c-due', -30)); // 10:04:30
      expect(db.agentCrons.dueNow(AT).map((d) => d.id)).toEqual(['c-due']);
    });

    test("another agent's run (a different cron's claim) in the same minute does not suppress this cron", () => {
      db = openDb(':memory:');
      db.agentCrons.insert(cron({ id: 'c-due' }));
      db.agentRuns.insert(run('r-other', 'some-other-agent', 'c-other', 15));
      expect(db.agentCrons.dueNow(AT).map((d) => d.id)).toEqual(['c-due']);
    });

    test('suppression is keyed per cron: a SAME-AGENT sibling cron due in the same minute is still returned', () => {
      // The scenario that motivated cron_id keying (spec gap resolution #2):
      // two crons for one agent, both due; only the already-claimed one is
      // suppressed.
      db = openDb(':memory:');
      db.agentCrons.insert(cron({ id: 'c-claimed' }));
      db.agentCrons.insert(cron({ id: 'c-sibling', createdAt: '2026-08-02T00:00:00.000Z' }));
      db.agentRuns.insert(run('r-claim', 'spiritguide-web', 'c-claimed', 20));
      expect(db.agentCrons.dueNow(AT).map((d) => d.id)).toEqual(['c-sibling']);
    });
  });
});
