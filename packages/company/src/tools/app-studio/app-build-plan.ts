import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { err, ok } from '@mcp/code-agent/core/tool.js';
import { parseAppWireframePlan } from '@mcp/app-studio/experience/types.js';
import { currentStage, parsePipelineState } from '@mcp/app-studio/pipeline/stages.js';
import { readTddCycles } from '@mcp/app-studio/architecture/tdd-cycles.js';
import { resolveHostPath } from '@mcp/company/tools/design-system/ds-publish-version.js';
import type { AppToolBinding } from './binding.js';
import { getAppStudioStore } from './store-binding.js';
import { appResult, PAGE_PROPERTIES, pageItems, viewArg } from './model-output.js';

const GET_PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    view: { type: 'string', enum: ['summary', 'current_group', 'groups', 'tasks', 'evidence', 'full'], description: "Default: 'summary'." },
    ...PAGE_PROPERTIES,
  },
  additionalProperties: false,
};

function load(binding: AppToolBinding) {
  const store = getAppStudioStore(); if (!store) throw new Error('AppStudioStore not wired.');
  const session = binding.resolveAppSession(store); if (!session) throw new Error(`No AppStudioSession bound to ${binding.describeBinding()}.`);
  const revision = store.getLatestApprovedWireframeRevision(session.id); if (!revision) throw new Error('No approved wireframe plan.');
  const plan = parseAppWireframePlan(revision.wireframe_json); if (!plan) throw new Error('Approved wireframe plan is invalid.');
  return { store, session, revision, plan };
}

export function appGetBuildPlan(binding: AppToolBinding): CoderTool {
  return { name: 'app_get_build_plan', description: 'Read the current flow group by default, or request a paged projection of groups, tasks and evidence.', parameters: GET_PARAMETERS, source: 'native', handler: async (args) => {
    try {
      const c = load(binding);
      const groupStates = c.store.listBuildGroups(c.revision.id);
      const taskEvidence = c.store.listBuildTaskEvidence(c.revision.id);
      const currentGroup = [...c.plan.build_groups]
        .sort((a, b) => a.sequence - b.sequence)
        .find((group) => groupStates.find((state) => state.group_id === group.id)?.status !== 'approved') ?? null;
      const currentTasks = currentGroup
        ? c.plan.tasks.filter((task) => task.group_id === currentGroup.id)
          .filter((task) => taskEvidence.find((item) => item.task_id === task.id)?.status !== 'done')
        : [];
      const view = viewArg(args, ['summary', 'current_group', 'groups', 'tasks', 'evidence', 'full'], 'summary');
      const base = {
        view,
        revision_id: c.revision.id,
        counts: {
          groups: c.plan.build_groups.length,
          tasks: c.plan.tasks.length,
          completed_tasks: taskEvidence.filter((item) => item.status === 'done').length,
        },
        current_group_id: currentGroup?.id ?? null,
      };
      if (view === 'full') return appResult('App build plan — full', { ...base, groups: c.plan.build_groups, tasks: c.plan.tasks, group_states: groupStates, task_evidence: taskEvidence });
      if (view === 'groups') {
        const page = pageItems(c.plan.build_groups, args, (item) => item.id);
        return appResult('App build plan — groups', { ...base, ...page, group_states: groupStates.filter((state) => page.items.some((group) => group.id === state.group_id)) });
      }
      if (view === 'tasks') {
        const page = pageItems(c.plan.tasks, args, (item) => item.id);
        return appResult('App build plan — tasks', { ...base, ...page, task_evidence: taskEvidence.filter((evidence) => page.items.some((task) => task.id === evidence.task_id)) });
      }
      if (view === 'evidence') return appResult('App build plan — evidence', { ...base, ...pageItems(taskEvidence, args, (item) => item.task_id) });
      const current = { ...base, current_group: currentGroup, tasks: currentTasks, task_evidence: taskEvidence.filter((item) => currentTasks.some((task) => task.id === item.task_id)) };
      return appResult(view === 'current_group' ? 'App build plan — current group' : 'App build plan — summary', current);
    }
    catch (e) { return err(`app_get_build_plan failed: ${(e as Error).message}`); }
  } };
}

const COMPLETE: JsonSchema = { type: 'object', properties: { task_id: { type: 'string' }, summary: { type: 'string' }, evidence: { type: 'object', description: 'Concrete evidence: test command/result, files, preview verification or accessibility result.' } }, required: ['task_id', 'summary', 'evidence'], additionalProperties: false };

export function buildTaskEvidenceIssue(
  task: { kind: string; tdd_case_ids: string[] },
  evidence: Record<string, unknown>,
  cycles: ReturnType<typeof readTddCycles>['cycles'],
): string | null {
  const strings = (value: unknown) => Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  if (task.kind === 'test-red' || task.kind === 'test-green') {
    const caseIds = strings(evidence.case_ids);
    const missing = task.tdd_case_ids.filter((id) => !caseIds.includes(id));
    if (missing.length > 0) return `Evidence must include every task TDD case: ${missing.join(', ')}.`;
    const phase = task.kind === 'test-red' ? 'red_at' : 'green_at';
    const unrecorded = task.tdd_case_ids.filter((id) => !cycles[id]?.[phase]);
    if (unrecorded.length > 0) return `Run and record the ${task.kind === 'test-red' ? 'red' : 'green'} TDD cycle first: ${unrecorded.join(', ')}.`;
    return null;
  }
  if (task.kind === 'preview') {
    if (typeof evidence.preview_url !== 'string' || !evidence.preview_url.trim() || evidence.visual_checked !== true) return 'Preview evidence requires preview_url and visual_checked:true.';
    return null;
  }
  if (strings(evidence.files).length === 0) return `Evidence for '${task.kind}' requires a non-empty files list.`;
  if (task.kind === 'responsive' && strings(evidence.viewports).length === 0) return 'Responsive evidence requires tested viewports.';
  if (task.kind === 'accessibility' && strings(evidence.checks).length === 0) return 'Accessibility evidence requires completed checks.';
  return null;
}

export function appCompleteBuildTask(binding: AppToolBinding): CoderTool {
  return { name: 'app_complete_build_task', description: 'Complete one task in the current flow group with concrete evidence. Dependencies, TDD cycles, preview proof, and group order are enforced.', parameters: COMPLETE, source: 'native', riskLevel: 'write', handler: async (args, ctx) => {
    try {
      const c = load(binding); const state = parsePipelineState(c.session.pipeline_json); if (!state) return err('The app pipeline is missing or invalid. Use Repair app first.'); if (currentStage(state)?.id !== 'design') return err('Build tasks are available only during the design stage.');
      const taskId = String(args.task_id ?? '').trim(); const task = c.plan.tasks.find((item) => item.id === taskId); if (!task) return err(`Unknown build task '${taskId}'.`);
      const groupStates = c.store.listBuildGroups(c.revision.id); const taskStates = c.store.listBuildTaskEvidence(c.revision.id);
      const currentGroup = [...c.plan.build_groups].sort((a, b) => a.sequence - b.sequence).find((group) => groupStates.find((state) => state.group_id === group.id)?.status !== 'approved');
      if (!currentGroup || currentGroup.id !== task.group_id) return err(`Task '${taskId}' is locked. Current flow group: '${currentGroup?.id ?? 'none'}'.`);
      if (groupStates.find((item) => item.group_id === currentGroup.id)?.status === 'review') return err(`Flow group '${currentGroup.id}' is waiting for user review.`);
      const missingDeps = task.depends_on.filter((id) => taskStates.find((item) => item.task_id === id)?.status !== 'done');
      if (missingDeps.length > 0) return err(`Complete task dependencies first: ${missingDeps.join(', ')}.`);
      const summary = String(args.summary ?? '').trim(); if (!summary) return err('summary is required.');
      const evidence = args.evidence && typeof args.evidence === 'object' ? args.evidence : null; if (!evidence || Object.keys(evidence as object).length === 0) return err('Concrete evidence is required.');
      const resolved = resolveHostPath('.', ctx); if (resolved.kind === 'no-bind-mount') return err(resolved.message);
      const evidenceIssue = buildTaskEvidenceIssue(task, evidence as Record<string, unknown>, readTddCycles(resolved.path).cycles); if (evidenceIssue) return err(evidenceIssue);
      c.store.setBuildTaskEvidence({ appSessionId: c.session.id, wireframeRevisionId: c.revision.id, taskId, status: 'done', summary, evidenceJson: JSON.stringify(evidence) });
      return ok(`Completed build task '${taskId}'.`);
    } catch (e) { return err(`app_complete_build_task failed: ${(e as Error).message}`); }
  } };
}

const SUBMIT: JsonSchema = { type: 'object', properties: { group_id: { type: 'string' }, summary: { type: 'string' } }, required: ['group_id', 'summary'], additionalProperties: false };
export function appSubmitBuildGroup(binding: AppToolBinding): CoderTool {
  return { name: 'app_submit_build_group', description: 'Submit the current flow group after every task has evidence. The user must approve it before the next group unlocks.', parameters: SUBMIT, source: 'native', riskLevel: 'write', handler: async (args) => {
    try {
      const c = load(binding); const groupId = String(args.group_id ?? '').trim(); const group = c.plan.build_groups.find((item) => item.id === groupId); if (!group) return err(`Unknown build group '${groupId}'.`);
      const states = c.store.listBuildGroups(c.revision.id); const current = [...c.plan.build_groups].sort((a, b) => a.sequence - b.sequence).find((item) => states.find((state) => state.group_id === item.id)?.status !== 'approved');
      if (current?.id !== groupId) return err(`Only current group '${current?.id ?? 'none'}' can be submitted.`);
      const missingGroupDeps = group.depends_on.filter((id) => states.find((state) => state.group_id === id)?.status !== 'approved'); if (missingGroupDeps.length > 0) return err(`Approve dependent groups first: ${missingGroupDeps.join(', ')}.`);
      const taskStates = c.store.listBuildTaskEvidence(c.revision.id); const incomplete = group.task_ids.filter((id) => taskStates.find((item) => item.task_id === id)?.status !== 'done'); if (incomplete.length > 0) return err(`Group tasks still incomplete: ${incomplete.join(', ')}.`);
      const summary = String(args.summary ?? '').trim(); if (!summary) return err('summary is required.');
      c.store.submitBuildGroup(c.session.id, c.revision.id, groupId, summary);
      return ok(`Flow group '${groupId}' submitted for user review. STOP until the user approves it.`);
    } catch (e) { return err(`app_submit_build_group failed: ${(e as Error).message}`); }
  } };
}
