/**
 * Agent Decision Engine (Phase 1 of the code-agent quality rework).
 *
 * Turns a user message (+ optional minimal session signals) into an explicit,
 * inspectable {@link AgentDecision}: recommended agent/mode, task intent,
 * lifecycle phase, risk/cost budget, delegation shape, and a tool policy.
 *
 * Design constraints (see the approved plan):
 *   - PURE & DETERMINISTIC: no I/O, no LLM, no clock — same input → same output.
 *     This makes it unit-testable and safe to run in SHADOW MODE (compute the
 *     recommendation, log it, but DO NOT auto-switch the agent or block tools).
 *   - ADVISORY: nothing here mutates runner state. Enforcement is a later phase.
 *   - SAFE ESCALATION: admin/git work sets `requiresExplicitUserIntent` so a
 *     caller never auto-promotes to destructive tiers.
 */
import type { AgentId } from '@mcp/code-agent/agents/index.js';
import { classifyIntent } from '@mcp/code-agent/agents/task-intent.js';
import type {
  AgentDecision,
  AgentDecisionGuidance,
  AgentDecisionTelemetry,
  CostBudget,
  DecisionConfidenceBand,
  DelegationPolicy,
  RiskBudget,
  TaskIntent,
  TaskPhase,
  ToolPolicy,
} from '@mcp/code-agent/agents/decision-types.js';

/** Optional session signals. All optional so callers can pass just a message. */
export interface DecisionContext {
  /** The agent currently active on the session, if any. */
  currentAgent?: AgentId | null;
  /** Whether the session already has conversation history (resumed work). */
  hasHistory?: boolean;
}

/** Per-intent routing profile. Pure data — the engine just looks it up. */
export interface IntentProfile {
  agent: AgentId;
  phase: TaskPhase;
  risk: RiskBudget;
  cost: CostBudget;
  /** Admin/destructive intents require an explicit user request to act on. */
  requiresExplicitUserIntent: boolean;
  toolPolicy: ToolPolicy;
}

/**
 * Static intent → routing table. This is the single source of truth that the
 * prompt matrix, tests, and (later) tool-selection all reference, killing the
 * documentation drift the investigation found.
 */
const INTENT_PROFILES: Record<TaskIntent, IntentProfile> = {
  answer: {
    agent: 'explore',
    phase: 'exploration',
    risk: 'read',
    cost: 'low',
    requiresExplicitUserIntent: false,
    toolPolicy: {
      preferred: [
        'mcp__get_project_pulse',
        'mcp__search',
        'mcp__grep_code',
        'read_file',
      ],
      discouraged: ['write_file', 'edit_file', 'run_command', 'git_commit'],
    },
  },
  locate: {
    agent: 'explore',
    phase: 'exploration',
    risk: 'read',
    cost: 'low',
    requiresExplicitUserIntent: false,
    toolPolicy: {
      preferred: ['mcp__search', 'mcp__grep_code', 'read_file', 'glob', 'mcp__find_references'],
      discouraged: ['write_file', 'edit_file', 'run_command'],
    },
  },
  plan: {
    agent: 'plan',
    phase: 'planning',
    // Plan mode is read-only until the plan is approved — the ceiling for the
    // planning turn itself is 'read'.
    risk: 'read',
    cost: 'medium',
    requiresExplicitUserIntent: false,
    toolPolicy: {
      preferred: [
        'mcp__search',
        'mcp__grep_code',
        'mcp__get_symbol_body',
        'mcp__prepare_edit',
        'mcp__find_references',
        'submit_plan',
      ],
      discouraged: ['write_file', 'edit_file', 'git_commit'],
    },
  },
  edit: {
    agent: 'build',
    phase: 'editing',
    risk: 'write',
    cost: 'medium',
    requiresExplicitUserIntent: false,
    toolPolicy: {
      preferred: ['mcp__get_symbol_body', 'mcp__prepare_edit', 'edit_file', 'get_diagnostics'],
      discouraged: ['git_commit', 'git_push', 'mcp__index_project'],
    },
  },
  verify: {
    agent: 'build',
    phase: 'verification',
    // Running tests/builds is execute-risk.
    risk: 'execute',
    cost: 'low',
    requiresExplicitUserIntent: false,
    toolPolicy: {
      preferred: ['get_diagnostics', 'lsp_diagnostics', 'run_command'],
      discouraged: ['write_file', 'edit_file', 'git_commit'],
    },
  },
  git_admin: {
    agent: 'admin',
    phase: 'editing',
    risk: 'admin',
    cost: 'low',
    // Never auto-escalate to git/admin work.
    requiresExplicitUserIntent: true,
    toolPolicy: {
      preferred: ['git_status', 'git_diff', 'git_log', 'git_add', 'git_commit'],
      discouraged: [],
    },
  },
  external_docs: {
    agent: 'research',
    phase: 'exploration',
    risk: 'read',
    cost: 'low',
    requiresExplicitUserIntent: false,
    toolPolicy: {
      preferred: ['rag_search_docs', 'rag_read_doc', 'web_search', 'web_fetch'],
      discouraged: ['write_file', 'edit_file', 'git_commit'],
    },
  },
  preview: {
    // Dedicated live-preview/UI editing agent. Intentionally NOT the generic
    // `build` agent: AGENTS.builder is the V0-style frontend builder preset.
    agent: 'builder',
    phase: 'editing',
    risk: 'write',
    cost: 'medium',
    requiresExplicitUserIntent: false,
    toolPolicy: {
      preferred: ['edit_file', 'get_diagnostics'],
      discouraged: ['git_commit', 'mcp__index_project'],
    },
  },
  diagram: {
    agent: 'diagram',
    phase: 'editing',
    risk: 'write',
    cost: 'medium',
    requiresExplicitUserIntent: false,
    toolPolicy: {
      preferred: ['diagram_create', 'diagram_update', 'diagram_read', 'diagram_list'],
      discouraged: ['write_file', 'edit_file', 'git_commit'],
    },
  },
  api_collection: {
    agent: 'api',
    phase: 'verification',
    // Runs endpoints against the live server — execute risk, its own loop.
    risk: 'execute',
    cost: 'high',
    requiresExplicitUserIntent: false,
    toolPolicy: {
      preferred: ['http_request', 'edit_file', 'get_diagnostics'],
      discouraged: ['git_commit', 'mcp__index_project'],
    },
  },
};

/**
 * Heuristic: does the message describe several INDEPENDENT areas worth fanning
 * out to parallel explore subagents? Deterministic (word count + conjunction
 * density) so it stays unit-testable. Conservative — only fires for clearly
 * broad read-only asks.
 */
function looksBroad(message: string): boolean {
  const lower = message.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean).length;
  const conjunctions = (lower.match(/\b(and|also|plus|além|tamb(e|é)m)\b/g) ?? []).length;
  // Conservative: a genuinely broad ask is reasonably long AND chains 2+
  // distinct investigations with coordinating conjunctions. Single-topic
  // questions almost never clear both bars at once.
  return words >= 20 && conjunctions >= 2;
}

/**
 * Pick the recommended delegation shape. Conservative: inline unless a broad,
 * read-only investigation clearly benefits from parallel explore subagents.
 */
function pickDelegation(intent: TaskIntent, message: string): DelegationPolicy {
  if ((intent === 'answer' || intent === 'locate') && looksBroad(message)) {
    return 'spawn_explore';
  }
  return 'inline';
}

/**
 * Compute the {@link AgentDecision} for a user message. Pure & deterministic.
 *
 * @param message Raw user message (any language).
 * @param ctx Optional minimal session signals.
 */
export function decide(message: string, ctx: DecisionContext = {}): AgentDecision {
  const classification = classifyIntent(message);
  const profile = INTENT_PROFILES[classification.intent];

  // On a fresh, low-confidence triage we surface the phase as 'triage' so
  // callers can tell "unsure orientation" apart from a confident exploration.
  const phase: TaskPhase =
    classification.confidence < 0.3 && !ctx.hasHistory ? 'triage' : profile.phase;

  const delegation = pickDelegation(classification.intent, message);

  const matchedNote =
    classification.matched.length > 0 ? ` (matched: ${classification.matched.join(', ')})` : '';
  const rationale =
    `intent=${classification.intent}${matchedNote} → agent=${profile.agent}, ` +
    `phase=${phase}, risk=${profile.risk}, cost=${profile.cost}, delegation=${delegation}`;

  return {
    recommendedAgent: profile.agent,
    intent: classification.intent,
    phase,
    riskBudget: profile.risk,
    costBudget: profile.cost,
    delegation,
    toolPolicy: profile.toolPolicy,
    confidence: classification.confidence,
    rationale,
    requiresExplicitUserIntent: profile.requiresExplicitUserIntent,
  };
}

/**
 * Expose the static routing table (read-only) so tests, the prompt builder, and
 * tool-selection can reference the SAME source of truth instead of re-deriving
 * the mapping (prevents drift).
 */
export function intentProfile(intent: TaskIntent): Readonly<IntentProfile> {
  return INTENT_PROFILES[intent];
}

/** Confidence below which policy hints are suppressed (treated as "unsure"). */
const MIN_POLICY_CONFIDENCE = 0.3;
const MIN_SWITCH_PROMPT_CONFIDENCE = 0.6;
const GUIDANCE_TOOL_HINT_LIMIT = 4;

function isSafeSwitchPromptTarget(decision: AgentDecision): boolean {
  if (decision.recommendedAgent !== 'admin') return true;
  return decision.requiresExplicitUserIntent;
}

function confidenceBand(confidence: number): DecisionConfidenceBand {
  if (confidence < MIN_POLICY_CONFIDENCE) return 'low';
  if (confidence >= 0.75) return 'high';
  return 'medium';
}

function capToolHints(tools: readonly string[]): readonly string[] {
  return tools.slice(0, GUIDANCE_TOOL_HINT_LIMIT);
}

function guidanceReminder(g: Omit<AgentDecisionGuidance, 'reminder'>): string {
  const preferred = g.preferredTools.length > 0
    ? ` use-first=${g.preferredTools.join(',')}`
    : '';
  const discouraged = g.discouragedTools.length > 0
    ? ` avoid=${g.discouragedTools.join(',')}`
    : '';
  const switchHint = g.shouldAskBeforeAgentSwitch
    ? ` ask-switch=${g.currentAgent ?? 'unknown'}→${g.recommendedAgent}`
    : '';
  const explicit = g.requiresExplicitUserIntent ? ' explicit-user-intent-required' : '';
  return [
    `agent_decision: intent=${g.intent}`,
    `agent=${g.recommendedAgent}`,
    `phase=${g.phase}`,
    `risk<=${g.riskBudget}`,
    `confidence=${g.confidenceBand}`,
    `delegation=${g.delegation}`,
    preferred,
    discouraged,
    switchHint,
    explicit,
  ].filter(Boolean).join('; ');
}

/** Convert a full decision to compact runtime guidance for prompts/guardrails. */
export function decisionGuidance(
  decision: AgentDecision,
  ctx: DecisionContext = {},
): AgentDecisionGuidance {
  const band = confidenceBand(decision.confidence);
  const currentAgent = ctx.currentAgent ?? null;
  const confidentEnoughToSwitch = decision.confidence >= MIN_SWITCH_PROMPT_CONFIDENCE;
  const safeSwitchTarget = isSafeSwitchPromptTarget(decision);
  const agentMismatch = Boolean(
    currentAgent &&
    currentAgent !== decision.recommendedAgent &&
    confidentEnoughToSwitch &&
    safeSwitchTarget,
  );
  const shouldAskBeforeAgentSwitch = agentMismatch;
  const preferredTools = capToolHints(decision.toolPolicy.preferred);
  const discouragedTools = capToolHints(decision.toolPolicy.discouraged);
  const guidanceBase: Omit<AgentDecisionGuidance, 'reminder'> = {
    recommendedAgent: decision.recommendedAgent,
    currentAgent,
    intent: decision.intent,
    phase: decision.phase,
    riskBudget: decision.riskBudget,
    costBudget: decision.costBudget,
    delegation: decision.delegation,
    confidence: decision.confidence,
    confidenceBand: band,
    requiresExplicitUserIntent: decision.requiresExplicitUserIntent,
    agentMismatch,
    shouldAskBeforeAgentSwitch,
    ...(shouldAskBeforeAgentSwitch
      ? { agentSwitchReason: `${decision.intent} work fits ${decision.recommendedAgent} better than ${currentAgent}.` }
      : {}),
    preferredTools,
    discouragedTools,
  };
  return { ...guidanceBase, reminder: guidanceReminder(guidanceBase) };
}

/** Compute compact runtime guidance directly from a task message. */
export function decisionGuidanceForTask(
  message: string,
  ctx: DecisionContext = {},
): AgentDecisionGuidance {
  return decisionGuidance(decide(message, ctx), ctx);
}

/**
 * Bridge to the tool-selection runtime: derive optional preferred/discouraged
 * tool hints from a task message, ready to pass to `applyToolSelection` /
 * `applyToolSelectionThin` (their `toolPolicy` field).
 *
 * Returns `undefined` when there is nothing actionable — the classifier was
 * not confident (an "unsure" triage, e.g. an unrecognized message) or both
 * hint lists are empty — so callers can forward the result with ZERO effect on
 * selection. This keeps the wiring conservative and shadow-mode friendly: tool
 * selection is only nudged when the intent was confidently recognized.
 */
export function toolPolicyForTask(
  message: string,
  ctx: DecisionContext = {},
): { preferred: readonly string[]; discouraged: readonly string[] } | undefined {
  const decision = decide(message, ctx);
  if (decision.confidence < MIN_POLICY_CONFIDENCE) return undefined;
  const { preferred, discouraged } = decision.toolPolicy;
  if (preferred.length === 0 && discouraged.length === 0) return undefined;
  return { preferred, discouraged };
}

/**
 * Compact, JSON-safe telemetry summary for a task decision. Unlike
 * `toolPolicyForTask`, this returns a value even for low-confidence triage so
 * shadow logs can measure "unknown/weak" classifications too. It intentionally
 * omits long tool arrays and rationale to keep counterfactual rows small.
 */
export function decisionTelemetryForTask(
  message: string,
  ctx: DecisionContext = {},
): AgentDecisionTelemetry {
  return decisionTelemetry(decide(message, ctx));
}

/** Convert a full decision to its compact telemetry form. */
export function decisionTelemetry(decision: AgentDecision): AgentDecisionTelemetry {
  return {
    recommendedAgent: decision.recommendedAgent,
    intent: decision.intent,
    phase: decision.phase,
    riskBudget: decision.riskBudget,
    costBudget: decision.costBudget,
    delegation: decision.delegation,
    confidence: decision.confidence,
    requiresExplicitUserIntent: decision.requiresExplicitUserIntent,
    toolPolicyPreferredCount: decision.toolPolicy.preferred.length,
    toolPolicyDiscouragedCount: decision.toolPolicy.discouraged.length,
  };
}
