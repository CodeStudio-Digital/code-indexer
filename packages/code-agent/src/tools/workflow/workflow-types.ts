/**
 * workflow-types — pure shapes + validation + wave planning for the
 * `workflow` tool (Ultra's standing declarative orchestrator).
 *
 * A workflow is a model-authored DAG of typed subagent steps:
 *   { id, title?, prompt, profile?, depends_on?, files? }
 * Steps whose dependencies are all satisfied run together as one parallel
 * wave (same engine as execute_tasks/spawn_agent). Kept pure so wave
 * planning and validation are unit-testable without a runner.
 */
import type { ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { MicroAgentProfileId } from '@mcp/code-agent/tools/micro-agent-profiles.js';
import type { SessionId } from '@mcp/session-storage';

export const WORKFLOW_MAX_STEPS = 12;
const STEP_ID_RE = /^[a-zA-Z0-9_-]{1,40}$/;

export type WorkflowStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  /** Budget/turn cutoff — finished with a salvage summary (benign). */
  | 'partial'
  | 'failed'
  /** A dependency did not complete — never dispatched. */
  | 'skipped';

export type WorkflowStatus = 'running' | 'completed' | 'partial' | 'failed' | 'aborted';

/** Older checkpoints encoded uncertainty only in the error; keep them fenced. */
export function workflowStepNeedsReconciliation(step: Pick<WorkflowStepState, 'effectOutcome' | 'error'>): boolean {
  return step.effectOutcome === 'unknown' || /outcome[_ ]unknown/i.test(step.error ?? '');
}

/** Raw step as accepted from the model (post-schema, pre-normalization). */
export interface WorkflowStepInput {
  id: string;
  title?: string;
  prompt: string;
  profile?: string;
  depends_on?: string[];
  accept_partial?: string[];
  acceptance?: string[];
  files?: string[];
}

export interface WorkflowStepState {
  id: string;
  title: string;
  prompt: string;
  profileId: MicroAgentProfileId;
  dependsOn: string[];
  acceptPartial?: string[];
  acceptance?: string[];
  result?: import('@mcp/agent-runtime-contracts').AgentWorkResult;
  integration?: { chatId: string; state: 'pending' | 'integrated' };
  files?: string[];
  /** 1-based wave index assigned by planWaves. */
  wave: number;
  status: WorkflowStepStatus;
  /** agents_group id of the wave dispatch — links UI lanes + resume registry. */
  groupId?: string;
  childChatId?: string;
  summary?: string;
  error?: string;
  effectOutcome?: 'unknown';
  toolCallCount?: number;
  usage?: ChatUsage;
}

export interface WorkflowRecord {
  planRevision?: number;
  planHistory?: Array<{ revision: number; at: number; stepIds: string[] }>;
  /** Missing on historical checkpoints means the legacy executor. */
  runtimeGeneration?: 'legacy_ts';
  id: string;
  name: string;
  sessionId?: SessionId;
  status: WorkflowStatus;
  steps: WorkflowStepState[];
  totalUsage: ChatUsage;
  createdAt: number;
  updatedAt: number;
  /** Bumped on every resume so retained wave groups stay unique. */
  runCount: number;
}

export interface WorkflowValidationIssue {
  stepId?: string;
  message: string;
}

/**
 * Structural validation: count, id shape/uniqueness, dependency references,
 * self-deps and cycles. Returns every issue found (not just the first) so the
 * model can fix the whole shape in one retry.
 */
export function validateWorkflowSteps(steps: readonly WorkflowStepInput[]): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  if (!Array.isArray(steps) || steps.length === 0) {
    return [{ message: 'workflow requires at least one step.' }];
  }
  if (steps.length > WORKFLOW_MAX_STEPS) {
    issues.push({ message: `workflow supports at most ${WORKFLOW_MAX_STEPS} steps (got ${steps.length}).` });
  }
  const ids = new Set<string>();
  for (const step of steps) {
    for (const dep of step.accept_partial ?? []) {
      if (!(step.depends_on ?? []).includes(dep)) issues.push({ stepId: step.id, message: `accept_partial '${dep}' must be a dependency` });
    }
    if (!STEP_ID_RE.test(step.id ?? '')) {
      issues.push({ stepId: step.id, message: `invalid step id '${step.id ?? ''}' — use 1-40 chars of [a-zA-Z0-9_-].` });
      continue;
    }
    if (ids.has(step.id)) issues.push({ stepId: step.id, message: `duplicate step id '${step.id}'.` });
    ids.add(step.id);
    if (typeof step.prompt !== 'string' || !step.prompt.trim()) {
      issues.push({ stepId: step.id, message: `step '${step.id}' needs a non-empty prompt.` });
    }
  }
  for (const step of steps) {
    for (const dep of step.depends_on ?? []) {
      if (dep === step.id) issues.push({ stepId: step.id, message: `step '${step.id}' cannot depend on itself.` });
      else if (!ids.has(dep)) issues.push({ stepId: step.id, message: `step '${step.id}' depends on unknown step '${dep}'.` });
    }
  }
  if (issues.length > 0) return issues;

  // Cycle detection via DFS coloring — only when references are sound.
  const byId = new Map(steps.map((s) => [s.id, s]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): boolean => {
    if (visited.has(id)) return true;
    if (visiting.has(id)) return false;
    visiting.add(id);
    for (const dep of byId.get(id)?.depends_on ?? []) {
      if (!visit(dep)) return false;
    }
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  for (const step of steps) {
    if (!visit(step.id)) {
      issues.push({ stepId: step.id, message: `dependency cycle detected involving step '${step.id}'.` });
      break;
    }
  }
  return issues;
}

/**
 * Topological wave planning over ids/depends_on — same semantics as
 * execute_tasks' buildWaves but generic over workflow steps. Terminal steps
 * (completed/partial/skipped on a resume) are excluded; their dependents
 * treat them as satisfied only when non-failed. Throws on cycle (callers
 * validate first; this is the safety net).
 */
export function planWaves(
  steps: ReadonlyArray<Pick<WorkflowStepState, 'id' | 'dependsOn' | 'status'>>,
): string[][] {
  const isTerminal = (s: { status: WorkflowStepStatus }): boolean =>
    s.status === 'completed' || s.status === 'partial' || s.status === 'skipped' || s.status === 'failed';
  const pending = new Map(steps.filter((s) => !isTerminal(s)).map((s) => [s.id, s]));
  const waves: string[][] = [];
  while (pending.size > 0) {
    const wave: string[] = [];
    for (const s of pending.values()) {
      const blocked = s.dependsOn.some((dep) => pending.has(dep));
      if (!blocked) wave.push(s.id);
    }
    if (wave.length === 0) {
      throw new Error(`workflow: dependency cycle detected — pending=${Array.from(pending.keys()).join(', ')}`);
    }
    for (const id of wave) pending.delete(id);
    waves.push(wave);
  }
  return waves;
}

/** Stamp the 1-based wave index on every step (pending steps only on resume). */
export function assignWaveIndexes(steps: WorkflowStepState[]): number {
  const waves = planWaves(steps);
  waves.forEach((ids, i) => {
    for (const id of ids) {
      const step = steps.find((s) => s.id === id);
      if (step) step.wave = i + 1;
    }
  });
  return waves.length;
}

export function countWorkflowOutcomes(record: WorkflowRecord): {
  completed: number; partial: number; failed: number; skipped: number; pending: number;
} {
  const counts = { completed: 0, partial: 0, failed: 0, skipped: 0, pending: 0 };
  for (const step of record.steps) {
    if (step.status === 'completed') counts.completed++;
    else if (step.status === 'partial') counts.partial++;
    else if (step.status === 'failed') counts.failed++;
    else if (step.status === 'skipped') counts.skipped++;
    else counts.pending++;
  }
  return counts;
}

/** Terminal workflow status from step outcomes (aborted is set by the runner). */
export function workflowStatusFromSteps(record: WorkflowRecord): WorkflowStatus {
  const counts = countWorkflowOutcomes(record);
  if (counts.failed > 0 || counts.skipped > 0) return 'failed';
  if (record.steps.some(step => step.integration?.state === 'pending')) return 'partial';
  if (counts.partial > 0) return 'partial';
  if (counts.pending > 0) return 'partial';
  return 'completed';
}
