/**
 * Live agent activity feed. Unions the three things agents actually do — runs,
 * chat replies (assistant + tool turns), and broadcast replies — into one
 * newest-first stream for the /agents page. Read-only; pure projection over the
 * existing repos.
 */
import { ActivityEventSchema, type ActivityEvent } from '@/lib/schemas';
import type { FounderDb } from '@/lib/db';

export function recentActivity(db: FounderDb, limit = 50): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  for (const run of db.agentRuns.recent(limit)) {
    // A scheduler claim (status='running') is written with a placeholder
    // `ok: false` before its worker has reported back (lib/agents/scheduler.ts)
    // — that is not a failure, it's in-flight. Only a run whose status is
    // NOT 'running' has an `ok` verdict worth rendering; the feed must never
    // show an in-progress run as a red FAIL (LCI-5 review round 4, missed by
    // round 1's fix to the roster card / analytics pie / harness cards).
    const ok = run.status === 'running' ? undefined : run.ok;
    events.push({ kind: 'run', agentId: run.agentId, at: run.startedAt, summary: run.summary, ok });
  }

  for (const msg of db.agentMessages.recent(limit)) {
    if (msg.role === 'user') continue; // the feed is what the agent did, not what you asked
    const summary =
      msg.role === 'tool'
        ? `tool · ${msg.toolCalls.map((c) => c.name).join(', ')}`
        : msg.content;
    events.push({ kind: 'message', agentId: msg.agentId, at: msg.createdAt, summary: summary.slice(0, 200) });
  }

  for (const b of db.broadcasts.recent(limit)) {
    for (const reply of b.replies) {
      events.push({ kind: 'broadcast', agentId: reply.agentId, at: reply.finishedAt, summary: reply.reply.slice(0, 200), ok: reply.ok });
    }
  }

  return events
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit)
    .map((e) => ActivityEventSchema.parse(e));
}
