export const RESEARCH_DEPTHS = ['quick', 'standard', 'deep', 'exhaustive'] as const;

export type ResearchDepth = typeof RESEARCH_DEPTHS[number];

export interface SubagentResearchPolicy {
  depth: ResearchDepth;
  source: 'explicit' | 'inferred' | 'budget';
  /** A synthesis checkpoint, never a tool-call cutoff. Zero disables this trigger. */
  softToolTarget: number;
  /** A synthesis checkpoint, never a wall-clock timeout. Zero disables this trigger. */
  softTimeTargetMs: number;
  completionCriteria: string[];
  parentGoalBudgetTokens?: number;
  budgetShareTokens?: number;
  /** Internal: keep custom targets intact when a parent goal budget is applied. */
  customTargets?: boolean;
}

export interface BuildResearchPolicyInput {
  task: string;
  explicitDepth?: ResearchDepth;
  targetMinutes?: number;
  targetToolCalls?: number;
  completionCriteria?: readonly string[];
  parentGoalBudgetTokens?: number;
  agentCount?: number;
}

interface DepthDefaults {
  softToolTarget: number;
  softTimeTargetMs: number;
  scope: string;
}

export const RESEARCH_DEPTH_DEFAULTS: Readonly<Record<ResearchDepth, DepthDefaults>> = {
  quick: {
    softToolTarget: 16,
    softTimeTargetMs: 3 * 60_000,
    scope: 'Decision-oriented scan: inspect only the reference and the few critical files needed to answer.',
  },
  standard: {
    softToolTarget: 40,
    softTimeTargetMs: 7 * 60_000,
    scope: 'Cover the critical path and material risks; do not attempt repository-wide coverage.',
  },
  deep: {
    softToolTarget: 80,
    softTimeTargetMs: 12 * 60_000,
    scope: 'Trace the requested surfaces end to end, including important alternatives and risks.',
  },
  exhaustive: {
    softToolTarget: 160,
    softTimeTargetMs: 25 * 60_000,
    scope: 'Audit the complete named scope. Exhaustive still means named scope, not unrelated repository areas.',
  },
};

const QUICK_PATTERN = /\b(quick|brief|r[aá]pid[oa]?|fast|triage|high[- ]level|resumo|vis[aã]o inicial|varredura inicial)\b/i;
const DEEP_PATTERN = /\b(deep|slow|thorough|comprehensive|extensive|end[- ]to[- ]end|ponta a ponta|lent[oa]?|demorad[oa]?|aprofundad[oa]?|detalhad[oa]?|(?:mais )?extens[oa]?)\b/i;
const EXHAUSTIVE_PATTERN = /\b(exhaustive|repository[- ]wide|repo[- ]wide|every file|all files|line by line|exaustiv[oa]?|repo(?:sit[oó]rio)? inteiro|todos os arquivos|linha por linha)\b/i;

export function normalizeResearchDepth(value: unknown): ResearchDepth | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return RESEARCH_DEPTHS.includes(normalized as ResearchDepth)
    ? normalized as ResearchDepth
    : undefined;
}

export function inferResearchDepth(task: string): ResearchDepth {
  // Most-specific wins. "Quick exhaustive audit" is still exhaustive unless
  // the caller resolves the ambiguity with an explicit research_depth.
  if (EXHAUSTIVE_PATTERN.test(task)) return 'exhaustive';
  if (DEEP_PATTERN.test(task)) return 'deep';
  if (QUICK_PATTERN.test(task)) return 'quick';
  return 'standard';
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizedCriteria(criteria: readonly string[] | undefined): string[] {
  if (!criteria) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of criteria) {
    const value = item.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value.slice(0, 500));
    if (out.length >= 12) break;
  }
  return out;
}

export function buildResearchPolicy(input: BuildResearchPolicyInput): SubagentResearchPolicy {
  const depth = input.explicitDepth ?? inferResearchDepth(input.task);
  const defaults = RESEARCH_DEPTH_DEFAULTS[depth];
  const targetMinutes = input.targetMinutes == null
    ? defaults.softTimeTargetMs
    : nonNegativeInteger(Math.round(input.targetMinutes * 60_000), defaults.softTimeTargetMs);
  const policy: SubagentResearchPolicy = {
    depth,
    source: input.explicitDepth ? 'explicit' : 'inferred',
    softToolTarget: nonNegativeInteger(input.targetToolCalls, defaults.softToolTarget),
    softTimeTargetMs: targetMinutes,
    completionCriteria: normalizedCriteria(input.completionCriteria),
    customTargets: input.targetMinutes != null || input.targetToolCalls != null,
  };
  return applyParentGoalBudget(policy, input.parentGoalBudgetTokens, input.agentCount);
}

export function applyParentGoalBudget(
  policy: SubagentResearchPolicy,
  parentGoalBudgetTokens: number | undefined,
  agentCount = 1,
): SubagentResearchPolicy {
  if (parentGoalBudgetTokens == null || !Number.isFinite(parentGoalBudgetTokens) || parentGoalBudgetTokens <= 0) {
    return policy;
  }
  const budget = Math.floor(parentGoalBudgetTokens);
  const share = Math.max(1, Math.floor(budget / Math.max(1, agentCount)));
  // A session-wide goal budget must influence delegated work. When the model
  // did not explicitly request a depth/target and the per-child share is small,
  // prefer a decision scan. This is still soft: no run is aborted at the share.
  if (policy.source === 'inferred' && !policy.customTargets && policy.depth === 'standard' && share < 8_000) {
    const quick = RESEARCH_DEPTH_DEFAULTS.quick;
    return {
      ...policy,
      depth: 'quick',
      source: 'budget',
      softToolTarget: quick.softToolTarget,
      softTimeTargetMs: quick.softTimeTargetMs,
      parentGoalBudgetTokens: budget,
      budgetShareTokens: share,
    };
  }
  return { ...policy, parentGoalBudgetTokens: budget, budgetShareTokens: share };
}

function formatTargetMs(ms: number): string {
  if (ms === 0) return 'disabled';
  const minutes = ms / 60_000;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} minutes`;
}

function criteriaBlock(policy: SubagentResearchPolicy): string {
  if (policy.completionCriteria.length === 0) {
    return '- Answer every explicit question in the delegated task with at least one verified evidence item.\n' +
      '- Put unresolved or unverified items under Open questions; they are not a reason to widen the scope.';
  }
  return policy.completionCriteria.map((criterion) => `- ${criterion}`).join('\n');
}

export function appendResearchContract(
  systemPrompt: string,
  policy: SubagentResearchPolicy | undefined,
): string {
  if (!policy) return systemPrompt;
  const defaults = RESEARCH_DEPTH_DEFAULTS[policy.depth];
  const budget = policy.parentGoalBudgetTokens
    ? `\n- Parent goal budget: ~${policy.parentGoalBudgetTokens} tokens session-wide` +
      `${policy.budgetShareTokens ? ` (~${policy.budgetShareTokens} planning share for this child)` : ''}. Prioritize decisions; this is not a cutoff.`
    : '';
  return `${systemPrompt}\n\n# Research contract (soft, not a watchdog)\n\n` +
    `- Depth: **${policy.depth}** (${policy.source}). ${defaults.scope}\n` +
    `- Synthesis targets: ${policy.softToolTarget || 'disabled'} tool calls; ${formatTargetMs(policy.softTimeTargetMs)}.${budget}\n` +
    '- Targets trigger a synthesis checkpoint only. They do not authorize skipping explicit completion criteria and never turn the run into partial/failure.\n' +
    '- File novelty is not decision novelty. Once the requested decisions have evidence, stop even if more files could be inspected.\n' +
    '- Prefer one strong source per decision. Add a second source only for ambiguity, conflict, or material risk.\n' +
    '- Batch independent read-only lookups when a batch surface is available.\n\n' +
    `## Completion criteria\n${criteriaBlock(policy)}\n\n` +
    'When every criterion is answered, produce the final summary immediately. Do not begin a new validation sweep.';
}

export function buildResearchSynthesisNudge(
  policy: SubagentResearchPolicy,
  trigger: 'tools' | 'time',
): string {
  const reached = trigger === 'tools'
    ? `${policy.softToolTarget} tool calls`
    : formatTargetMs(policy.softTimeTargetMs);
  return `\n\n# SYNTHESIS CHECKPOINT\n\n` +
    `You reached the ${policy.depth} soft research target (${reached}). This is not a failure or hard cap.\n` +
    'On this turn, stop expanding the search and produce the final evidence-backed summary if the completion criteria are answered. ' +
    'If one named criterion is still unanswered, perform only the minimum direct lookup for that criterion, then summarize. ' +
    'Convert anything still uncertain into Open questions. Do not start another broad validation sweep.';
}

export function researchPolicyCacheKey(policy: SubagentResearchPolicy | undefined): string {
  if (!policy) return 'research:none';
  return [
    'research', policy.depth, policy.softToolTarget, policy.softTimeTargetMs,
    ...policy.completionCriteria,
  ].join(':');
}
