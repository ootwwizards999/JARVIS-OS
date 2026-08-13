import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { FounderDb } from '@/lib/db';

// The route dispatches through the injected seam (`lib/agents/dispatch`,
// this ticket's stub spawner) — never a real process. Mock it for every test
// in this file so nothing can ever spawn.
vi.mock('@/lib/agents/dispatch', () => ({ dispatchDecision: vi.fn() }));

beforeAll(() => {
  // Route reads through the getDb() singleton; point it at :memory: before
  // anything imports @/lib/data. Never touches data/founder-os.db.
  process.env.FOUNDER_OS_DB = ':memory:';
});

afterEach(async () => {
  // Ticks use wall-clock "now", so determinism comes from cron lifecycle:
  // no cron survives the test that created it.
  const { getDb } = await import('@/lib/data');
  const db = getDb();
  for (const c of db.agentCrons.all()) db.agentCrons.remove(c.id);
  vi.clearAllMocks();
});

const tick = () => new Request('http://localhost/api/scheduler/tick', { method: 'POST' });

type RunRow = Parameters<FounderDb['agentRuns']['insert']>[0];

/** A cron that is due on EVERY minute — deterministic without freezing time. */
function everyMinuteCron(db: FounderDb, id: string, agentId: string) {
  db.agentCrons.insert({
    id,
    agentId,
    schedule: '* * * * *',
    description: 'scheduler route test cron',
    enabled: true,
    createdAt: '2026-08-01T00:00:00.000Z',
  });
}

/** A foreign in-flight run consuming lane capacity (extended LCI-5 shape). */
function runningRun(id: string, lane: string): RunRow {
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
    cronId: null,
  };
  return row as unknown as RunRow;
}

describe('POST /api/scheduler/tick', () => {
  test('returns { dispatched, denied, reasons } and dispatches through the injected seam', async () => {
    const { POST } = await import('@/app/api/scheduler/tick/route');
    const { getDb } = await import('@/lib/data');
    const { dispatchDecision } = await import('@/lib/agents/dispatch');
    const db = getDb();
    everyMinuteCron(db, 'cron-shape', 'route-shape-agent');

    const res = await POST(tick());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ dispatched: 1, denied: 0 });
    expect(body.reasons).toEqual([]);

    expect(vi.mocked(dispatchDecision)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchDecision).mock.calls[0][0]).toMatchObject({
      agentId: 'route-shape-agent',
      permitted: true,
    });
  });

  test("claims survive the call: a status='running' row exists for the dispatched cron", async () => {
    const { POST } = await import('@/app/api/scheduler/tick/route');
    const { getDb } = await import('@/lib/data');
    const db = getDb();
    everyMinuteCron(db, 'cron-claims', 'route-claims-agent');

    const res = await POST(tick());
    expect((await res.json()).dispatched).toBe(1);

    const runs = db.agentRuns.byAgent('route-claims-agent');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agentId: 'route-claims-agent', status: 'running' });
    expect(runs[0].finishedAt).toBeNull();
  });

  test('completes in under 100ms with a stub dispatcher', async () => {
    const { POST } = await import('@/app/api/scheduler/tick/route');
    const { getDb } = await import('@/lib/data');
    const db = getDb();
    // Warm module init + first-touch DB work outside the timed window; the
    // 100ms acceptance budget is for the tick itself, not cold start.
    await POST(tick());
    everyMinuteCron(db, 'cron-timing', 'route-timing-agent');

    const started = performance.now();
    const res = await POST(tick());
    const elapsed = performance.now() - started;

    expect(res.status).toBe(200);
    expect((await res.json()).dispatched).toBe(1);
    expect(elapsed).toBeLessThan(100);
  });

  test('never blocks on worker completion: a 500ms dispatcher does not delay the response', async () => {
    const { POST } = await import('@/app/api/scheduler/tick/route');
    const { getDb } = await import('@/lib/data');
    const { dispatchDecision } = await import('@/lib/agents/dispatch');
    const db = getDb();
    await POST(tick()); // warm, outside the timed window
    everyMinuteCron(db, 'cron-slow', 'route-slow-agent');

    let workerFinished = false;
    let worker: Promise<void> = Promise.resolve();
    vi.mocked(dispatchDecision).mockImplementationOnce((() => {
      worker = new Promise<void>((resolve) =>
        setTimeout(() => {
          workerFinished = true;
          resolve();
        }, 500),
      );
      return worker;
    }) as never);

    const started = performance.now();
    const res = await POST(tick());
    const elapsed = performance.now() - started;

    expect(res.status).toBe(200);
    expect((await res.json()).dispatched).toBe(1);
    // The response came back while the worker was still running.
    expect(workerFinished).toBe(false);
    expect(elapsed).toBeLessThan(100);

    await worker; // don't leak the timer past the test
  });

  test('reports denials: { dispatched: 0, denied: 1, reasons: [non-empty] }, dispatches nothing, claims nothing', async () => {
    const { POST } = await import('@/app/api/scheduler/tick/route');
    const { getDb } = await import('@/lib/data');
    const { dispatchDecision } = await import('@/lib/agents/dispatch');
    const db = getDb();
    // Saturate build-light (cap 3); spiritguide-web maps to build-light.
    db.agentRuns.insert(runningRun('bl-1', 'build-light'));
    db.agentRuns.insert(runningRun('bl-2', 'build-light'));
    db.agentRuns.insert(runningRun('bl-3', 'build-light'));
    everyMinuteCron(db, 'cron-denied', 'spiritguide-web');

    const res = await POST(tick());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dispatched).toBe(0);
    expect(body.denied).toBe(1);
    expect(body.reasons).toHaveLength(1);
    expect(typeof body.reasons[0]).toBe('string');
    expect(body.reasons[0]).not.toBe('');

    expect(vi.mocked(dispatchDecision)).not.toHaveBeenCalled();
    expect(db.agentRuns.byAgent('spiritguide-web')).toEqual([]);
  });
});
