import { afterEach, describe, expect, test, vi } from 'vitest';
import { openDb, type FounderDb } from '@/lib/db';
import { planTick, runTick } from '@/lib/agents/scheduler';

let db: FounderDb;

afterEach(() => {
  db?.close();
});

// 10:05 local — matches the `*/5 * * * *` fixture cron.
const AT = new Date('2026-08-13T10:05:00');
// A minute the fixture cron does NOT match.
const OFF_MINUTE = new Date('2026-08-13T10:03:00');

type RunRow = Parameters<FounderDb['agentRuns']['insert']>[0];

function seedWebCron(d: FounderDb, opts?: { enabled?: boolean }) {
  d.departments.insert({
    id: 'dept-tech',
    name: 'Tech & Automations',
    slug: 'tech',
    tagline: '',
    color: '#3b82f6',
    order: 1,
  });
  d.agents.insert({
    id: 'spiritguide-web',
    departmentId: 'dept-tech',
    name: 'Spirit Guide Web',
    role: 'Implementer',
    status: 'active',
    tier: 'specialist',
    description: 'First lane wired end-to-end (build-light).',
    model: 'claude-sonnet-4-6',
    tools: [],
    parentId: null,
    instance: 'builtin',
  });
  d.agentCrons.insert({
    id: 'cron-web',
    agentId: 'spiritguide-web',
    schedule: '*/5 * * * *',
    description: 'spiritguide-web tick',
    enabled: opts?.enabled ?? true,
    createdAt: '2026-08-01T00:00:00.000Z',
  });
}

/** A running run in another lane's agent, started well before AT. */
function foreignRunningRun(id: string, lane: string): RunRow {
  const row = {
    id,
    agentId: `other-${id}`,
    startedAt: '2026-08-13T09:00:00.000Z',
    finishedAt: null,
    ok: false,
    summary: '',
    status: 'running',
    lane,
    decisionType: 'code.implement',
  };
  return row as unknown as RunRow;
}

const sameMinute = (iso: string, at: Date) =>
  Math.floor(new Date(iso).getTime() / 60_000) === Math.floor(at.getTime() / 60_000);

describe('planTick', () => {
  test('is pure: two calls on identical DB state return identical decisions and write nothing', () => {
    db = openDb(':memory:');
    seedWebCron(db);

    const runsBefore = db.agentRuns.recent(100);
    const cronsBefore = db.agentCrons.all();

    const first = planTick(db, AT);
    const second = planTick(db, AT);

    // Identical decisions, decided twice from the same state.
    expect(second).toEqual(first);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ agentId: 'spiritguide-web', permitted: true });

    // Zero writes: the tables the tick touches are byte-identical.
    expect(db.agentRuns.recent(100)).toEqual(runsBefore);
    expect(db.agentRuns.recent(100)).toEqual([]);
    expect(db.agentCrons.all()).toEqual(cronsBefore);
  });

  test('spiritguide-web is planned on the build-light lane', () => {
    db = openDb(':memory:');
    seedWebCron(db);
    const decisions = planTick(db, AT);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ agentId: 'spiritguide-web', lane: 'build-light' });
  });

  test('returns no decisions when no cron matches the minute', () => {
    db = openDb(':memory:');
    seedWebCron(db);
    expect(planTick(db, OFF_MINUTE)).toEqual([]);
  });

  test('returns a denial with a non-empty reason when the lane is saturated — still without writing', () => {
    db = openDb(':memory:');
    seedWebCron(db);
    // build-light cap is 3; saturate it with other agents' running runs.
    db.agentRuns.insert(foreignRunningRun('bl-1', 'build-light'));
    db.agentRuns.insert(foreignRunningRun('bl-2', 'build-light'));
    db.agentRuns.insert(foreignRunningRun('bl-3', 'build-light'));
    const runsBefore = db.agentRuns.recent(100);

    const decisions = planTick(db, AT);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].permitted).toBe(false);
    expect(typeof decisions[0].reason).toBe('string');
    expect(decisions[0].reason).not.toBe('');

    expect(db.agentRuns.recent(100)).toEqual(runsBefore);
  });
});

describe('runTick', () => {
  test('dispatches a due, permitted cron through the injected dispatcher — never spawning anything', () => {
    db = openDb(':memory:');
    seedWebCron(db);
    const dispatch = vi.fn();

    runTick(db, AT, dispatch);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ agentId: 'spiritguide-web', permitted: true });
  });

  test("claims the dispatch as an agent_runs row: status='running', finishedAt null, started in the tick's minute", () => {
    db = openDb(':memory:');
    seedWebCron(db);

    runTick(db, AT, vi.fn());

    const runs = db.agentRuns.byAgent('spiritguide-web');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agentId: 'spiritguide-web', status: 'running' });
    expect(runs[0].finishedAt).toBeNull();
    expect(sameMinute(runs[0].startedAt, AT)).toBe(true);
  });

  test('replaying the same tick minute does not double-dispatch', () => {
    db = openDb(':memory:');
    seedWebCron(db);
    const dispatch = vi.fn();

    runTick(db, AT, dispatch);
    runTick(db, AT, dispatch); // launchd replay / manual curl of the same minute

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(db.agentRuns.byAgent('spiritguide-web')).toHaveLength(1);
  });

  test('a denied decision is not dispatched and claims no run', () => {
    db = openDb(':memory:');
    seedWebCron(db);
    db.agentRuns.insert(foreignRunningRun('bl-1', 'build-light'));
    db.agentRuns.insert(foreignRunningRun('bl-2', 'build-light'));
    db.agentRuns.insert(foreignRunningRun('bl-3', 'build-light'));
    const dispatch = vi.fn();

    runTick(db, AT, dispatch);

    expect(dispatch).not.toHaveBeenCalled();
    expect(db.agentRuns.byAgent('spiritguide-web')).toEqual([]);
  });

  test('a disabled cron never dispatches', () => {
    db = openDb(':memory:');
    seedWebCron(db, { enabled: false });
    const dispatch = vi.fn();

    runTick(db, AT, dispatch);

    expect(dispatch).not.toHaveBeenCalled();
    expect(db.agentRuns.byAgent('spiritguide-web')).toEqual([]);
  });
});
