/**
 * Shared types for the Agent Decision Engine (Phase 1 of the code-agent
 * quality rework).
 *
 * The engine turns a user message + minimal session signals into an explicit,
 * inspectable decision: which agent/mode fits, what the task intent is, where
 * we are in the task lifecycle (phase), and what tool/risk/cost budget the
 * turn should respect. It is intentionally PURE and DETERMINISTIC so it can be
 * unit-tested, A/B compared, and run in shadow mode (compute-only) before any
 * enforcement is wired into the runner.
 *
 * These types are kept dependency-light on purpose: only type-only imports, so
 * the module participates in no runtime import cycle.
 */
import type { AgentId } from '@mcp/code-agent/agents/index.js';
import type { ToolRiskLevel } from '@mcp/code-agent/core/tool.js';

/**
 * What the user is fundamentally trying to do this turn. Drives agent/mode
 * routing and the tool policy. Ordered loosely from "read-only" to "mutating".
 */
export type TaskIntent =
  | 'answer' // explain / what / why / how does X work
  | 'locate' // find / where is / search for a symbol or file
  | 'plan' // design / approach / strategy before changing
  | 'edit' // implement / fix / refactor / add / remove code
  | 'verify' // run tests / typecheck / build / lint
  | 'git_admin' // commit / push / branch / tag / release / merge
  | 'external_docs' // look up library/framework documentation
  | 'preview' // UI / live-preview / screenshot work
  | 'diagram' // draw.io diagrams (flowchart, architecture, ER, ...)
  | 'api_collection'; // OpenAPI/Swagger collection authoring & verification

/** Where we are in the task lifecycle — drives which tools are surfaced. */
export type TaskPhase =
  | 'triage' // first read of the request; cheap orientation
  | 'exploration' // searching/reading to understand
  | 'impact_mapping' // references/dependencies before changing
  | 'planning' // designing the change, pre-approval
  | 'editing' // applying changes
  | 'verification' // proving it works (tests/build/diagnostics)
  | 'summarization'; // reporting the result

/** Maximum risk class a turn should reach. Mirrors {@link ToolRiskLevel}. */
export type RiskBudget = ToolRiskLevel; // 'read' | 'write' | 'execute' | 'admin'

/** Rough economy hint for routing and delegation. */
export type CostBudget = 'low' | 'medium' | 'high';

/**
 * How the work should be carried out — inline vs delegated. Advisory: the
 * runner/model still decides, but this records the recommended shape.
 */
export type DelegationPolicy =
  | 'inline' // do it directly in the main context
  | 'spawn_explore' // 2+ independent read-only investigations → parallel explore subagents
  | 'spawn_implement' // a scoped, file-bounded change → implement subagent
  | 'execute_tasks' // an approved multi-task plan → wave-based orchestration
  | 'persistent_subordinate'; // company-master only → long-lived coder

/** Preferred / discouraged tool names for the current intent+phase. */
export interface ToolPolicy {
  /** Tools the agent should reach for first this turn (by canonical name). */
  preferred: readonly string[];
  /** Tools that are usually the wrong choice for this intent/phase. */
  discouraged: readonly string[];
}

/**
 * The full, explicit decision. Every field is serialisable so it can be logged
 * to telemetry (shadow mode) and compared against what the agent actually did.
 */
export interface AgentDecision {
  /** Best-fit agent/mode for this task. Advisory — never auto-switched here. */
  recommendedAgent: AgentId;
  /** Classified task intent. */
  intent: TaskIntent;
  /** Lifecycle phase the turn is most likely in. */
  phase: TaskPhase;
  /** Maximum risk the turn should reach without escalation. */
  riskBudget: RiskBudget;
  /** Rough cost/economy profile. */
  costBudget: CostBudget;
  /** Recommended execution shape (inline vs delegated). */
  delegation: DelegationPolicy;
  /** Preferred / discouraged tools for this intent+phase. */
  toolPolicy: ToolPolicy;
  /** Classifier confidence in [0, 1]. */
  confidence: number;
  /** Short human-readable explanation — for telemetry/debug, not the user. */
  rationale: string;
  /**
   * True when the recommendation must only be acted on with an EXPLICIT user
   * request (admin/git mutations). Guards against auto-escalation.
   */
  requiresExplicitUserIntent: boolean;
}

/** Result of intent classification, before it is mapped to a full decision. */
export interface IntentClassification {
  intent: TaskIntent;
  /** Confidence in [0, 1]. */
  confidence: number;
  /** The keyword(s) that triggered the match — for debugging/telemetry. */
  matched: readonly string[];
}
