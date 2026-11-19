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
 * User-defined agents live outside this static registry. The HTTP layer stores
 * them in `app_settings`, resolves their built-in base preset, and passes only
 * the runtime overrides (prompt, automatic skills, tool allowlist) to runCoder.
 */
import type { CoderProfile } from '@mcp/code-agent/tools/tiers.js';

export type AgentId =
  | 'explore'
  | 'research'
  | 'plan'
  | 'build'
  | 'admin'
  | 'spec'
  | 'app_db'
  | 'builder'
  | 'api'
  | 'diagram';

export interface AgentDefinition {
  id: AgentId;
  /** Human-facing name. Keep `id` stable for stored sessions, prompts and APIs. */
  label: string;
  description: string;
  profile: CoderProfile;
  /** Starts the runner in plan mode — mutating tools blocked until submit_plan approved. */
  planMode: boolean;
  /** Spec mode: agent must submit_spec and get approval before mutating tools. */
  specMode?: boolean;
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
    label: 'Explore',
    description:
      'Read-only investigation with the compact core catalog. Context-specific capabilities are injected only when this agent runs inside that surface.',
    profile: 'bootstrap',
    planMode: false,
    defaultTemperature: 0.2,
  },
  plan: {
    id: 'plan',
    label: 'Plan',
    description:
      'Read + planning with plan mode ON — the agent must submit_plan and get approval before any mutating tool.',
    profile: 'navigate',
    planMode: true,
    defaultTemperature: 0.4,
  },
  build: {
    id: 'build',
    label: 'Code',
    description:
      'Read + edit + shell + git-read, without a plan gate. Runtime-specific capabilities are added by the active workspace context.',
    profile: 'navigate',
    planMode: false,
    defaultTemperature: 0.2,
  },
  admin: {
    id: 'admin',
    label: 'Ops',
    description:
      'Full core catalog including privileged operations. Context-specific capabilities are still injected only by the active workspace.',
    profile: 'full',
    planMode: false,
    defaultTemperature: 0.1,
    confirmBeforeIrreversible: true,
  },
  spec: {
    id: 'spec',
    label: 'Spec Doc',
    description:
      'Spec-driven authoring. Navigate tier with dedicated spec gate — must submit_spec and get human approval before mutating the workspace. One spec → N tasks/PRs.',
    profile: 'navigate',
    planMode: false,
    specMode: true,
    defaultTemperature: 0.3,
  },
  research: {
    id: 'research',
    label: 'Research',
    description:
      'Read-only source research with indexed docs, web search/fetch, and an isolated anonymous browser for JavaScript-driven public pages.',
    profile: 'bootstrap',
    planMode: false,
    defaultTemperature: 0.2,
  },
  app_db: {
    id: 'app_db',
    label: 'Database',
    description:
      'Database specialist. Inspects registered connections, explains schemas and data, runs safe read-only analysis, and gates every mutation behind explicit approval.',
    profile: 'bootstrap',
    planMode: false,
    defaultTemperature: 0.2,
  },
  builder: {
    id: 'builder',
    label: 'UI Builder',
    description:
      'V0-style frontend builder. Navigate tier, no plan gate. Tailwind + shadcn/ui, element-targeted edits from the live preview, self-healing from console/network errors. Used by the Builder studio.',
    profile: 'navigate',
    planMode: false,
    // Slightly higher than `build` (0.2) — UI work benefits from a touch
    // more variation in layout/styling choices while staying coherent.
    defaultTemperature: 0.5,
  },
  api: {
    id: 'api',
    label: 'API Test',
    description:
      'API verification. Imports an OpenAPI/Swagger spec, runs each endpoint against the LIVE dev server, compares responses against the intended contract, corrects confirmed defects and marks checked requests verified — building a non-LLM regression battery. Navigate tier + the `api` tool tier; edit_file patches the spec.',
    profile: 'navigate',
    planMode: false,
    // Verification, not creativity — keep it deterministic.
    defaultTemperature: 0.1,
  },
  diagram: {
    id: 'diagram',
    label: 'Diagram',
    description:
      'Draw.io diagrams. Authors complex diagrams (flowchart, software/cloud architecture, network, ER, sequence, C4) as real .drawio files rendered in a live embedded editor. Navigate tier + the `diagram` tool tier (diagram_create/update/read/list/export). Use to design architecture and implementation solutions visually.',
    profile: 'navigate',
    planMode: false,
    // Visual design benefits from a little variation while staying coherent.
    defaultTemperature: 0.4,
  },
};

export function isAgentId(v: string): v is AgentId {
  return Object.prototype.hasOwnProperty.call(AGENTS, v);
}

export function getAgent(id: AgentId): AgentDefinition {
  return AGENTS[id];
}

/** Return a short one-line summary of all agents — used by `--help` and the dashboard picker. */
export function agentsSummary(): string {
  return Object.values(AGENTS)
    .map((a) => `  ${a.id.padEnd(8)} ${a.label.padEnd(10)} ${a.description}`)
    .join('\n');
}
