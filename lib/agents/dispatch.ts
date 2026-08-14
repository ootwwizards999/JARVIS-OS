import type { DispatchDecision } from '@/lib/agents/scheduler';

/**
 * Dispatch seam (LCI-5). This ticket ships the injected seam and a stub only
 * — it records intent and spawns no process. The real `claude -p` spawner
 * (detached, short-lived, per the spec's dispatch model) is the next ticket.
 *
 * The route imports this exact path so `vi.mock('@/lib/agents/dispatch')`
 * can intercept it in tests — nothing may ever actually spawn from a test run.
 */
export function dispatchDecision(decision: DispatchDecision): void {
  void decision;
}
