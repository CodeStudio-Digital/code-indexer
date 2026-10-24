import type { CoderTask } from '@mcp/session-storage/session-state-types.js';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import {
  FULL_ACCESS_FILTER,
  READ_ONLY_FILTER,
  READ_WRITE_FILTER,
  VERIFY_FILTER,
  type PathScopeMode,
  type SubagentAllowlist,
} from '@mcp/code-agent/tools/implement-subagent.js';
import { REVIEW_ALLOWLIST } from '@mcp/code-agent/tools/review-subagent.js';
import {
  EXPLORE_SYSTEM_PROMPT,
  IMPLEMENT_SYSTEM_PROMPT,
} from '@mcp/code-agent/tools/subagent.js';

export const VERIFY_SYSTEM_PROMPT = `You are a VERIFY subagent. The parent agent delegated a verification task to you.

You have READ access + shell + LSP diagnostics. You CANNOT edit any code.
Your job: run the relevant tests / linters / type-checkers, observe results, report what passed and what failed.

# Rules
1. Use run_command for tests/linters. Use get_diagnostics / lsp_diagnostics for LSP-driven checks.
2. NEVER attempt to write or patch files. If you find an issue, report it - the parent agent will dispatch a fix.
3. Stop and write a final summary listing what was verified and the result.
4. NEVER end your run with only tool calls and no text.

# Output format

## Verified
- <check name>: passed | failed (<short reason>)

## Failures (if any)
- <test/file>: <short error excerpt> at <file:line>

## Suggested next step
<one line - usually "fix X in Y" - or "all green, no action">
`;

const REVIEW_PROFILE_PROMPT = `You are a REVIEW subagent. The parent agent delegated a focused review to you.

You have read-only access. Review only the supplied scope, diff, files, or question. Do not make edits.

# Focus
1. Find concrete bugs, regressions, security issues, and missing tests.
2. Cite evidence with file:line when possible.
3. Skip style nits unless they hide a real defect.
4. If there is no actionable issue, say so clearly.

# Output format

## Findings
- [severity] file:line - issue and suggested fix

## Confidence
<high/medium/low + why>
`;

export type MicroAgentProfileId =
  | 'explore'
  | 'implement'
  | 'verify'
  | 'review'
  | 'full';

export type MicroAgentProfileName =
  | MicroAgentProfileId
  | 'investigate'
  | 'investigator'
  | 'readonly'
  | 'implementer'
  | 'worker'
  | 'verifier'
  | 'reviewer';

export type MicroAgentCapability =
  | 'explore'
  | 'implement'
  | 'verify'
  | 'review'
  | 'full';

export interface MicroAgentProfile {
  id: MicroAgentProfileId;
  aliases: readonly MicroAgentProfileName[];
  capability: MicroAgentCapability;
  description: string;
  systemPrompt: string;
  allowlist: SubagentAllowlist;
  pathScopeMode: PathScopeMode;
  defaultLabel: string;
}

const REVIEW_FILTER: (tool: CoderTool) => boolean = (tool) => {
  if (REVIEW_ALLOWLIST.has(tool.name)) return true;
  return tool.source === 'mcp_external' && tool.mutates === false;
};

export const MICRO_AGENT_PROFILES: Readonly<Record<MicroAgentProfileId, MicroAgentProfile>> = {
  explore: {
    id: 'explore',
    aliases: ['explore', 'investigate', 'investigator', 'readonly'],
    capability: 'explore',
    description: 'Read-only investigation with code navigation and non-mutating MCP tools.',
    systemPrompt: EXPLORE_SYSTEM_PROMPT,
    allowlist: READ_ONLY_FILTER,
    pathScopeMode: 'warn',
    defaultLabel: 'investigate',
  },
  implement: {
    id: 'implement',
    aliases: ['implement', 'implementer', 'worker'],
    capability: 'implement',
    description: 'Scoped implementation with write, shell, diagnostics, and external MCP tools.',
    systemPrompt: IMPLEMENT_SYSTEM_PROMPT,
    allowlist: READ_WRITE_FILTER,
    pathScopeMode: 'enforce-writes',
    defaultLabel: 'implement',
  },
  verify: {
    id: 'verify',
    aliases: ['verify', 'verifier'],
    capability: 'verify',
    description: 'Read + shell verification for tests, linters, type-checkers, and diagnostics.',
    systemPrompt: VERIFY_SYSTEM_PROMPT,
    allowlist: VERIFY_FILTER,
    pathScopeMode: 'warn',
    defaultLabel: 'verify',
  },
  review: {
    id: 'review',
    aliases: ['review', 'reviewer'],
    capability: 'review',
    description: 'Read-only second opinion focused on bugs, regressions, security, and test gaps.',
    systemPrompt: REVIEW_PROFILE_PROMPT,
    allowlist: REVIEW_FILTER,
    pathScopeMode: 'warn',
    defaultLabel: 'review',
  },
  full: {
    id: 'full',
    aliases: ['full'],
    capability: 'full',
    description: 'Unfiltered subagent that inherits the parent tool registry.',
    systemPrompt: IMPLEMENT_SYSTEM_PROMPT,
    allowlist: FULL_ACCESS_FILTER,
    pathScopeMode: 'warn',
    defaultLabel: 'full',
  },
};

/**
 * Canonical micro-agent profile ids — the single source of truth for
 * per-profile subagent model config (HTTP route validation + admin UI).
 */
export const SUBAGENT_PROFILE_IDS = Object.keys(MICRO_AGENT_PROFILES) as MicroAgentProfileId[];

const PROFILE_BY_NAME: ReadonlyMap<string, MicroAgentProfile> = (() => {
  const entries: Array<[string, MicroAgentProfile]> = [];
  for (const profile of Object.values(MICRO_AGENT_PROFILES)) {
    for (const alias of profile.aliases) entries.push([alias, profile]);
  }
  return new Map(entries);
})();

export const MICRO_AGENT_PROFILE_NAMES = Array.from(PROFILE_BY_NAME.keys()).sort();

export function resolveMicroAgentProfile(name: string | undefined | null): MicroAgentProfile | null {
  if (!name) return null;
  return PROFILE_BY_NAME.get(name.trim().toLowerCase()) ?? null;
}

export function microAgentProfileForTaskKind(kind: CoderTask['kind'] | undefined): MicroAgentProfile {
  switch (kind) {
    case 'investigate':
      return MICRO_AGENT_PROFILES.explore;
    case 'verify':
      return MICRO_AGENT_PROFILES.verify;
    case 'implement':
    default:
      return MICRO_AGENT_PROFILES.implement;
  }
}
