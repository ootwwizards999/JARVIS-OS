import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { runTick } from '@/lib/agents/scheduler';
import { dispatchDecision } from '@/lib/agents/dispatch';

export const dynamic = 'force-dynamic';

/**
 * The tick loop (LCI-5). Called once a minute by launchd. Claims due,
 * permitted crons as `agent_runs` rows and hands them to the injected
 * dispatcher — never awaited, so this must return before any worker
 * finishes. Detached workers report their own result back later.
 */
export async function POST(_request: Request) {
  const db = getDb();
  const decisions = runTick(db, new Date(), dispatchDecision);
  const denied = decisions.filter((d) => !d.permitted);

  return NextResponse.json({
    dispatched: decisions.length - denied.length,
    denied: denied.length,
    reasons: denied.map((d) => d.reason),
  });
}
