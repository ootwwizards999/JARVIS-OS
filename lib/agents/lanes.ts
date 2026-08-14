import { realAgents } from '@/lib/agents/real';

/**
 * Lane + autonomy registry (LCI-5). Code-side only — no schema change to
 * `agents` or `agent_crons` in this ticket. Every agent id the tick engine can
 * see resolves here before it ever reaches the governor.
 *
 * Fail-safe is a REQUIREMENT, not a convenience default: an id nobody
 * registered must resolve to the safest possible values — `no-build` /
 * autonomy 1 — never to something permissive. A gate that fails open reports
 * safety it doesn't provide.
 */
export type Lane = 'build-heavy' | 'build-light' | 'no-build';

export type AgentLaneEntry = {
  lane: Lane;
  autonomy: number;
  decisionType: string;
};

/** The one mapping the acceptance criteria name. */
const REGISTRY: Record<string, AgentLaneEntry> = {
  'spiritguide-web': { lane: 'build-light', autonomy: 3, decisionType: 'code.implement' },
};

/** Agents already registered in lib/agents/real.ts, but not given a specific lane above. */
const DEFAULT_REGISTERED: AgentLaneEntry = { lane: 'no-build', autonomy: 2, decisionType: 'ticket.triage' };

/** Unknown/unregistered agent id — the safest values, never a permissive default. */
const FAILSAFE: AgentLaneEntry = { lane: 'no-build', autonomy: 1, decisionType: 'ticket.triage' };

const realAgentIds = new Set(realAgents.map((a) => a.id));

export function resolveAgentLane(agentId: string): AgentLaneEntry {
  if (!agentId) return { ...FAILSAFE };
  if (agentId in REGISTRY) return { ...REGISTRY[agentId] };
  if (realAgentIds.has(agentId)) return { ...DEFAULT_REGISTERED };
  return { ...FAILSAFE };
}
