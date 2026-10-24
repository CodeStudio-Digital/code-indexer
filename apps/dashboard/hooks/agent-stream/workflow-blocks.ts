/**
 * workflow-blocks — stream-block projection for the `workflow` tool (Ultra).
 * Mirrors agents-blocks.ts: pure functions that mutate/replace the blocks
 * array from workflow_* SSE events, so handlers.ts stays thin. Workflow wave
 * agent groups (groupId `wf<run>-wf_<id>-w<n>`) do NOT create their own
 * agents block — the workflow card is the canonical surface; live per-agent
 * telemetry is folded INTO the matching step row instead.
 */
import type { AgentProgressPayload } from './agents-blocks.js';
import type { StreamBlock, Usage, WorkflowRunState, WorkflowStepStatus, WorkflowStepView } from './types.js';

const WORKFLOW_WAVE_GROUP_RE = /^wf\d+-wf_[^-]+-w\d+$/;

/** True for agents_group ids emitted by workflow wave dispatches. */
export function isWorkflowWaveGroup(groupId: string): boolean {
  return WORKFLOW_WAVE_GROUP_RE.test(groupId);
}

export interface WorkflowRunStartedPayload {
  workflow_id: string;
  name: string;
  resumed?: boolean;
  total_waves: number;
  steps: Array<{
    id: string;
    title: string;
    profile: string;
    depends_on: string[];
    wave: number;
    status: WorkflowStepStatus;
  }>;
}

export interface WorkflowStepUpdatePayload {
  workflow_id: string;
  step_id: string;
  status: WorkflowStepStatus;
  group_id?: string;
  summary?: string;
  error?: string;
  tool_call_count?: number;
  usage?: Usage;
}

export interface WorkflowRunFinishedPayload {
  workflow_id: string;
  status: 'completed' | 'partial' | 'failed' | 'aborted';
  total_usage?: Usage;
}

function findWorkflowRun(blocks: StreamBlock[], workflowId: string): WorkflowRunState | null {
  for (const block of blocks) {
    if (block.type === 'workflow' && block.run.workflowId === workflowId) return block.run;
  }
  return null;
}

/** Upsert the workflow card. A resume re-emit merges by workflowId. */
export function applyWorkflowRunStarted(blocks: StreamBlock[], d: WorkflowRunStartedPayload): void {
  const steps: WorkflowStepView[] = d.steps.map((step) => ({
    id: step.id,
    title: step.title,
    profile: step.profile,
    dependsOn: step.depends_on ?? [],
    wave: step.wave,
    status: step.status,
  }));
  const existingIndex = blocks.findIndex(
    (b) => b.type === 'workflow' && b.run.workflowId === d.workflow_id,
  );
  const prior = existingIndex >= 0 && blocks[existingIndex].type === 'workflow'
    ? (blocks[existingIndex] as { type: 'workflow'; run: WorkflowRunState }).run
    : null;
  const run: WorkflowRunState = {
    workflowId: d.workflow_id,
    name: d.name,
    status: 'running',
    totalWaves: d.total_waves,
    // On a resume, keep prior summaries/usages for steps the new roster still
    // reports as terminal — the payload carries statuses, not results.
    steps: steps.map((step) => {
      const was = prior?.steps.find((s) => s.id === step.id);
      return was && step.status !== 'pending' ? { ...was, ...step } : step;
    }),
    resumed: d.resumed ?? prior?.resumed,
    startedAt: prior?.startedAt ?? new Date().toISOString(),
  };
  if (existingIndex >= 0) blocks[existingIndex] = { type: 'workflow', run };
  else blocks.push({ type: 'workflow', run });
}

export function applyWorkflowStepUpdate(blocks: StreamBlock[], d: WorkflowStepUpdatePayload): boolean {
  const run = findWorkflowRun(blocks, d.workflow_id);
  if (!run) return false;
  const idx = run.steps.findIndex((step) => step.id === d.step_id);
  if (idx < 0) return false;
  const step = run.steps[idx];
  run.steps[idx] = {
    ...step,
    status: d.status,
    ...(d.group_id ? { groupId: d.group_id } : {}),
    ...(d.summary ? { summary: d.summary } : {}),
    ...(d.error ? { error: d.error } : {}),
    ...(d.tool_call_count != null ? { toolCallCount: d.tool_call_count } : {}),
    ...(d.usage ? { usage: d.usage } : {}),
  };
  return true;
}

export function applyWorkflowRunFinished(blocks: StreamBlock[], d: WorkflowRunFinishedPayload): boolean {
  const run = findWorkflowRun(blocks, d.workflow_id);
  if (!run) return false;
  run.status = d.status;
  run.totalUsage = d.total_usage;
  run.finishedAt = new Date().toISOString();
  return true;
}

/**
 * Fold live agent telemetry into the matching step row. Workflow specs use
 * the step id as the agent LABEL, so (wave groupId, label) identifies the
 * step. Returns true when a step changed.
 */
export function patchWorkflowStepFromAgentProgress(
  blocks: StreamBlock[],
  d: AgentProgressPayload,
): boolean {
  if (!isWorkflowWaveGroup(d.groupId)) return false;
  for (const block of blocks) {
    if (block.type !== 'workflow') continue;
    const idx = block.run.steps.findIndex(
      (step) => step.id === d.label && (step.groupId === d.groupId || step.groupId == null),
    );
    if (idx < 0) continue;
    const step = block.run.steps[idx];
    block.run.steps[idx] = {
      ...step,
      groupId: d.groupId,
      ...(d.toolCallCount != null ? { toolCallCount: d.toolCallCount } : {}),
      ...(d.lastToolName ? { lastToolName: d.lastToolName } : {}),
      ...(d.phase ? { phase: d.phase } : {}),
      ...(d.limit?.maxToolCalls != null && d.limit.maxToolCalls > 0
        ? { maxToolCalls: d.limit.maxToolCalls }
        : {}),
    };
    return true;
  }
  return false;
}
