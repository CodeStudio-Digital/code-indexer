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
import type { CoderProfile } from '@mcp/code-agent/tools/tiers.js';

export type AgentId = 'explore' | 'plan' | 'build' | 'admin' | 'spec' | 'builder';

export interface AgentDefinition {
  id: AgentId;
  description: string;
  profile: CoderProfile;
  /** Starts the runner in plan mode — mutating tools blocked until submit_plan approved. */
  planMode: boolean;
  /** Spec mode: agent must submit_spec and get approval before mutating tools. */
  specMode?: boolean;
  /** Optional max-turns override for this agent. */
  maxTurns?: number;
  /**
   * Default sampling temperature for this agent. Resolver clamps to [0, 1].
   * Lower = more deterministic (good for code, admin); higher = more creative
   * (planning brainstorm). Overridden by per-session or per-role values.
   */
  defaultTemperature?: number;
  /**
   * When true, the runner pauses for an explicit user confirmation before
   * invoking any tool classified as irreversible — internal mutations
   * (git_commit, snapshot mutations, index_project) AND external MCP tools
   * whose name matches the destructive-verb heuristic (delete/create/
   * publish/apply/commit/push/update/replace/drop/destroy/remove).
   *
   * False by default. Only `admin` opts in — `build` still runs through
   * planMode + tier filtering as its safety net, while `admin` is the
   * mode the user explicitly enters for irreversible work.
   */
  confirmBeforeIrreversible?: boolean;
}

export const AGENTS: Record<AgentId, AgentDefinition> = {
  explore: {
    id: 'explore',
    description:
      'Read-only investigation. Bootstrap tools only (~17). Use for "explain", "find", "where", "how does X work".',
    profile: 'bootstrap',
    planMode: false,
    maxTurns: 50,
    defaultTemperature: 0.2,
  },
  plan: {
    id: 'plan',
    description:
      'Read + planning. Navigate tier (~47 tools) with plan mode ON — the agent must submit_plan and get approval before any mutating tool.',
    profile: 'navigate',
    planMode: true,
    defaultTemperature: 0.4,
  },
  build: {
    id: 'build',
    description:
      'Read + edit + shell + git-read. Navigate tier (~47 tools), no plan gate. Use when you trust end-to-end execution (small features, bugfixes).',
    profile: 'navigate',
    planMode: false,
    defaultTemperature: 0.2,
  },
  admin: {
    id: 'admin',
    description:
      'Everything unlocked. Full tier (~60 tools) including git_commit, add_snapshot, index_project. Use only when the user explicitly asks for admin actions.',
    profile: 'full',
    planMode: false,
    defaultTemperature: 0.1,
    confirmBeforeIrreversible: true,
  },
  spec: {
    id: 'spec',
    description:
      'Spec-driven authoring. Navigate tier with dedicated spec gate — must submit_spec and get human approval before mutating the workspace. One spec → N tasks/PRs.',
    profile: 'navigate',
    planMode: false,
    specMode: true,
    maxTurns: 120,
    defaultTemperature: 0.3,
  },
  builder: {
    id: 'builder',
    description:
      'V0-style frontend builder. Navigate tier, no plan gate. Tailwind + shadcn/ui, element-targeted edits from the live preview, self-healing from console/network errors. Used by the Builder studio.',
    profile: 'navigate',
    planMode: false,
    // Slightly higher than `build` (0.2) — UI work benefits from a touch
    // more variation in layout/styling choices while staying coherent.
    defaultTemperature: 0.5,
  },
};

export function isAgentId(v: string): v is AgentId {
  return (
    v === 'explore' ||
    v === 'plan' ||
    v === 'build' ||
    v === 'admin' ||
    v === 'spec' ||
    v === 'builder'
  );
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
