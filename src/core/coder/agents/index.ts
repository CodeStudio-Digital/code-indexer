/**
 * Agent profiles — first-class presets for the coder runner.
 *
 * An "agent" is just a bundle of settings (tool tier profile, plan mode,
 * optional custom prompt variant) that matches a common usage pattern. The
 * plumbing underneath is still the same runner + tier system; agents exist
 * so users don't have to know "profile bootstrap + planMode false = what
 * opencode calls the explore agent".
 *
 * Four built-in agents mirror opencode's mental model:
 *
 *   explore — read-only investigation. Bootstrap tier, no plan mode. Use
 *             for "explain", "find", "where is", "how does X work".
 *   plan    — read + planning. Navigate tier, plan mode ON. Use when you
 *             want the agent to gather context, propose a plan, and stop
 *             for review before touching anything.
 *   build   — read + edit + shell + git-read. Navigate tier, no plan mode.
 *             Use when you trust the agent to go end-to-end without a plan
 *             gate (small features, bugfixes).
 *   admin   — everything unlocked. Full tier, no plan mode. Use for git
 *             mutations, snapshot management, indexing — rarely default.
 *
 * Per-project customization lives outside this file: `.mcp-indexer/agents/
 * {id}.json` can override any field except `id`.
 */
import type { CoderProfile } from '../tools/tiers.js';

export type AgentId = 'explore' | 'plan' | 'build' | 'admin';

export interface AgentDefinition {
  id: AgentId;
  description: string;
  profile: CoderProfile;
  /** Starts the runner in plan mode — mutating tools blocked until submit_plan approved. */
  planMode: boolean;
  /** Optional max-turns override for this agent. */
  maxTurns?: number;
}

export const AGENTS: Record<AgentId, AgentDefinition> = {
  explore: {
    id: 'explore',
    description:
      'Read-only investigation. Bootstrap tools only (~17). Use for "explain", "find", "where", "how does X work".',
    profile: 'bootstrap',
    planMode: false,
    maxTurns: 50,
  },
  plan: {
    id: 'plan',
    description:
      'Read + planning. Navigate tier (~47 tools) with plan mode ON — the agent must submit_plan and get approval before any mutating tool.',
    profile: 'navigate',
    planMode: true,
  },
  build: {
    id: 'build',
    description:
      'Read + edit + shell + git-read. Navigate tier (~47 tools), no plan gate. Use when you trust end-to-end execution (small features, bugfixes).',
    profile: 'navigate',
    planMode: false,
  },
  admin: {
    id: 'admin',
    description:
      'Everything unlocked. Full tier (~60 tools) including git_commit, add_snapshot, index_project. Use only when the user explicitly asks for admin actions.',
    profile: 'full',
    planMode: false,
  },
};

export function isAgentId(v: string): v is AgentId {
  return v === 'explore' || v === 'plan' || v === 'build' || v === 'admin';
}

export function getAgent(id: AgentId): AgentDefinition {
  return AGENTS[id];
}

/** Return a short one-line summary of all agents — used by `--help` and the dashboard picker. */
export function agentsSummary(): string {
  return Object.values(AGENTS)
    .map((a) => `  ${a.id.padEnd(8)} ${a.description}`)
    .join('\n');
}
