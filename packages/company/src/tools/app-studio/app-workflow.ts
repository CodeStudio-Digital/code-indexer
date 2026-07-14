import type { CoderTask, TasksState } from '@mcp/code-agent/sessions/types.js';
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { err, ok } from '@mcp/code-agent/core/tool.js';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import { auditAppSpec } from '@mcp/app-studio/spec/audit.js';
import { parseAppProductModel } from '@mcp/app-studio/product/types.js';
import { auditAppProductModel } from '@mcp/app-studio/product/audit.js';
import { parseAppWireframePlan } from '@mcp/app-studio/experience/types.js';
import { auditAppDeliveryBlueprint, auditAppReleaseReadiness } from '@mcp/app-studio/workflow/audit.js';
import { parseAppAgentConfig } from '@mcp/app-studio/workflow/agent-config.js';
import { deriveAppWorkflowState, parseAppWorkflowState, serializeAppWorkflowState } from '@mcp/app-studio/workflow/state.js';
import { dependentWorkItemIds, planAdaptiveDispatch } from '@mcp/app-studio/workflow/scheduler.js';
import type { AppApproval, AppDeliveryBlueprint, AppWorkItem, AppWorkItemKind, AppWorkItemStatus, AppWorkflowPhaseId } from '@mcp/app-studio/workflow/types.js';
import type { AppStudioApproval, AppStudioSession, AppStudioStore, AppStudioWorkItem } from '@mcp/store/app-studio-store.js';
import type { AppToolBinding } from './binding.js';
import { getAppStudioStore } from './store-binding.js';
import { appResult, PAGE_PROPERTIES, pageItems, viewArg } from './model-output.js';

const json = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};
const hydrateItem = ({ depends_on_json, source_ids_json, acceptance_json, evidence_json, file_scope_json, run_json, ...row }: AppStudioWorkItem): AppWorkItem => ({
  ...row,
  depends_on: json(depends_on_json, []), source_ids: json(source_ids_json, []),
  acceptance: json(acceptance_json, []), evidence: json(evidence_json, []),
  file_scope: json(file_scope_json, []), run: json(run_json, null),
});
const hydrateApproval = ({ bundle_json, ...row }: AppStudioApproval): AppApproval => ({
  ...row, bundle: json(bundle_json, {}),
});

const EMPTY: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };
const WORKFLOW_READ_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    view: { type: 'string', enum: ['summary', 'attention', 'board', 'card'], description: 'Progressive workflow projection. Default: summary.' },
    work_item_id: { type: 'string', description: 'Required for view=card.' },
    ...PAGE_PROPERTIES,
  },
  additionalProperties: false,
};

type BoundApp = { ok: false; error: string } | { ok: true; store: AppStudioStore; session: AppStudioSession };

function bound(binding: AppToolBinding): BoundApp {
  const store = getAppStudioStore();
  if (!store) return { ok: false, error: 'AppStudioStore not wired.' };
  const session = binding.resolveAppSession(store);
  if (!session) return { ok: false, error: `No AppStudioSession bound to ${binding.describeBinding()}.` };
  return { ok: true, store, session };
}

export function appGetWorkflow(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_get_workflow',
    description: 'Read the authoritative App Studio v5 workflow progressively: summary, attention, paginated board or one full card.',
    parameters: WORKFLOW_READ_SCHEMA, source: 'native', mutates: false, parallelSafe: true,
    handler: async (args) => {
      const value = bound(binding); if (!value.ok) return err(value.error);
      const state = parseAppWorkflowState(value.session.pipeline_json);
      if (!state) return err('Workflow v5 is not initialized yet. Open the App Studio journey once to migrate it safely.');
      const items = value.store.listWorkItems(value.session.id).map(hydrateItem);
      const approvals = value.store.listApprovals(value.session.id).map(hydrateApproval);
      const decisions = value.store.listDecisionRequests(value.session.id).map(({ options_json, blocked_work_item_ids_json, ...row }) => ({
        ...row,
        options: json<Array<{ label: string; value: string }>>(options_json, []),
        blocked_work_item_ids: json<string[]>(blocked_work_item_ids_json, []),
      }));
      const derived = deriveAppWorkflowState(state, approvals, items);
      const agentConfig = parseAppAgentConfig(value.session.agent_config_json);
      const view = viewArg(args, ['summary', 'attention', 'board', 'card'], 'summary');
      if (view === 'attention') return appResult('App workflow — attention', {
        approvals: approvals.filter((item) => item.status === 'pending'),
        decisions: decisions.filter((item) => item.status === 'open'),
        guidance: 'Only linked cards are blocked. Continue independent ready work.',
      });
      if (view === 'card') {
        const id = typeof args.work_item_id === 'string' ? args.work_item_id : '';
        const item = items.find((candidate) => candidate.id === id);
        return item ? appResult(`App workflow — ${id}`, item) : err(`Unknown work item '${id || '(missing work_item_id)'}'.`);
      }
      if (view === 'board') return appResult('App workflow — board', pageItems(items, args, (item) => item.id));
      return appResult('App workflow v5', {
        coordinator_session_id: value.session.coordinator_session_id,
        coordinator_instruction: agentConfig.coordinator_prompt || null,
        phases: derived.phases.map((phase) => ({ id: phase.id, status: phase.status })),
        attention: {
          approvals: approvals.filter((item) => item.status === 'pending').length,
          decisions: decisions.filter((item) => item.status === 'open').length,
        },
        board: Object.fromEntries(['backlog', 'ready', 'running', 'review', 'done', 'blocked', 'stale', 'cancelled'].map((status) => [status, items.filter((item) => item.status === status).length])),
        guidance: 'Approval is asynchronous. Continue every independent ready card.',
      });
    },
  };
}

const UPSERT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    items: { type: 'array', minItems: 1, items: { type: 'object', properties: {
      id: { type: 'string' }, phase: { type: 'string', enum: ['define', 'blueprint', 'build', 'deliver'] },
      slice_id: { type: ['string', 'null'] }, title: { type: 'string' }, outcome: { type: 'string' },
      kind: { type: 'string', enum: ['research', 'plan', 'contract', 'implement', 'verify', 'release', 'change'] },
      owner_profile: { type: 'string' }, priority: { type: 'integer', minimum: 1, maximum: 5 },
      status: { type: 'string', enum: ['backlog', 'ready', 'blocked', 'stale', 'cancelled'] }, sort_order: { type: 'integer' },
      depends_on: { type: 'array', items: { type: 'string' } }, source_ids: { type: 'array', items: { type: 'string' } },
      acceptance: { type: 'array', items: { type: 'string' } }, file_scope: { type: 'array', items: { type: 'string' } },
      blocked_reason: { type: ['string', 'null'] },
      corrects_work_item_id: { type: ['string', 'null'] },
    }, required: ['id', 'phase', 'title', 'outcome', 'kind', 'source_ids', 'acceptance'] } },
  }, required: ['items'], additionalProperties: false,
} as JsonSchema;

export function appUpsertWorkItems(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_upsert_work_items',
    description: 'Create or refine traceable App Studio Kanban cards. Only backlog/ready status can be changed here; active, exceptional and terminal state plus evidence are preserved.',
    parameters: UPSERT_SCHEMA, source: 'native', mutates: true, parallelSafe: false,
    handler: async (args) => {
      const value = bound(binding); if (!value.ok) return err(value.error);
      const raw = Array.isArray(args.items) ? args.items as Array<Record<string, unknown>> : [];
      if (raw.length === 0) return err('items is required.');
      const ids = new Set(raw.map((item) => String(item.id ?? '')));
      if (ids.has('') || ids.size !== raw.length) return err('Every work item needs a unique non-empty id.');
      const existing = value.store.listWorkItems(value.session.id);
      const known = new Set([...existing.map((item) => item.id), ...ids]);
      const dependencies = new Map(existing.map((item) => [item.id, json<string[]>(item.depends_on_json, [])]));
      const metadata = new Map(existing.map((item) => [item.id, { kind: item.kind, owner: item.owner_profile }]));
      for (const item of raw) {
        const id = String(item.id);
        const deps = Array.isArray(item.depends_on) ? item.depends_on.map(String) : [];
        const missing = deps.filter((id) => !known.has(id));
        if (missing.length) return err(`Work item '${id}' depends on unknown item(s): ${missing.join(', ')}.`);
        if (deps.includes(id)) return err(`Work item '${id}' cannot depend on itself.`);
        const kind = String(item.kind) as AppWorkItemKind;
        const owner = typeof item.owner_profile === 'string' ? item.owner_profile : kind === 'verify' ? 'verify' : 'coordinator';
        dependencies.set(id, deps);
        metadata.set(id, { kind, owner });
        if (typeof item.corrects_work_item_id === 'string' && !known.has(item.corrects_work_item_id)) {
          return err(`Work item '${id}' corrects unknown item '${item.corrects_work_item_id}'.`);
        }
        if (item.corrects_work_item_id === id) return err(`Work item '${id}' cannot correct itself.`);
      }
      const visiting = new Set<string>();
      const visited = new Set<string>();
      const visit = (id: string): string | null => {
        if (visiting.has(id)) return id;
        if (visited.has(id)) return null;
        visiting.add(id);
        for (const dependency of dependencies.get(id) ?? []) {
          const cycle = visit(dependency);
          if (cycle) return cycle;
        }
        visiting.delete(id);
        visited.add(id);
        return null;
      };
      for (const id of dependencies.keys()) {
        const cycle = visit(id);
        if (cycle) return err(`Work item dependency graph contains a cycle through '${cycle}'.`);
      }
      for (const item of raw) {
        const id = String(item.id);
        const meta = metadata.get(id)!;
        if (meta.kind !== 'verify') continue;
        for (const dependencyId of dependencies.get(id) ?? []) {
          const dependency = metadata.get(dependencyId);
          if (dependency && (dependency.kind === 'implement' || dependency.kind === 'contract') && dependency.owner === meta.owner) {
            return err(`Verifier '${id}' must use a different owner profile from implementation '${dependencyId}'.`);
          }
        }
      }
      const saved = value.store.upsertWorkItems(raw.map((item, index) => ({
        id: String(item.id), app_session_id: value.session.id, phase: String(item.phase) as AppWorkflowPhaseId,
        slice_id: typeof item.slice_id === 'string' ? item.slice_id : null, title: String(item.title), outcome: String(item.outcome),
        kind: String(item.kind) as AppWorkItemKind, owner_profile: typeof item.owner_profile === 'string' ? item.owner_profile : String(item.kind) === 'verify' ? 'verify' : 'coordinator',
        priority: typeof item.priority === 'number' ? item.priority : 2, status: (typeof item.status === 'string' ? item.status : 'backlog') as AppWorkItemStatus,
        sort_order: typeof item.sort_order === 'number' ? item.sort_order : index,
        depends_on_json: JSON.stringify(Array.isArray(item.depends_on) ? item.depends_on : []),
        source_ids_json: JSON.stringify(Array.isArray(item.source_ids) ? item.source_ids : []),
        acceptance_json: JSON.stringify(Array.isArray(item.acceptance) ? item.acceptance : []),
        file_scope_json: JSON.stringify(Array.isArray(item.file_scope) ? item.file_scope : []),
        blocked_reason: typeof item.blocked_reason === 'string' ? item.blocked_reason : null,
        run_json: typeof item.corrects_work_item_id === 'string' ? JSON.stringify({ corrects_work_item_id: item.corrects_work_item_id }) : null,
      })));
      value.store.refreshReadyWorkItems(value.session.id);
      const wireframeRow = value.store.getLatestWireframeRevision(value.session.id);
      const wireframe = parseAppWireframePlan(wireframeRow?.wireframe_json);
      const board = value.store.listWorkItems(value.session.id).map(hydrateItem);
      if (wireframe && board.some((item) => item.phase === 'build')) {
        const blueprint: AppDeliveryBlueprint = {
          v: 1,
          refs: {
            spec_revision_id: value.store.getLatestApprovedSpecRevision(value.session.id)?.id ?? null,
            product_revision_id: value.store.getLatestProductRevision(value.session.id)?.id ?? null,
            architecture_revision_id: value.store.getLatestArchitectureRevision(value.session.id)?.id ?? null,
            ux_revision_id: value.store.getLatestUxRevision(value.session.id)?.id ?? null,
            wireframe_revision_id: wireframeRow?.id ?? null,
          },
          slices: wireframe.delivery_slices.map((slice) => {
            const cards = board.filter((item) => item.slice_id === slice.id);
            const flows = wireframe.flows.filter((flow) => slice.flow_ids.includes(flow.id));
            return {
              id: slice.id,
              capability_ids: slice.capability_ids,
              journey_ids: [],
              source_ids: [...new Set([...flows.flatMap((flow) => flow.source_ids), ...cards.flatMap((item) => item.source_ids)])],
              screen_ids: slice.screen_ids,
              entity_names: [...new Set(wireframe.checklist_items.filter((item) => item.slice_id === slice.id).flatMap((item) => item.entity_names))],
              behavior_ids: flows.flatMap((flow) => flow.source_ids.filter((source) => source.startsWith('behavior:')).map((source) => source.slice('behavior:'.length))),
              acceptance_test_ids: [...new Set(wireframe.checklist_items.filter((item) => item.slice_id === slice.id).flatMap((item) => item.tdd_case_ids))],
              work_item_ids: cards.map((item) => item.id),
            };
          }),
          test_matrix: wireframe.tdd_cases.map((test) => ({
            id: test.id,
            source_ids: test.source_ids,
            slice_id: wireframe.delivery_slices.find((slice) => slice.flow_ids.some((flowId) => test.flow_ids.includes(flowId)))?.id ?? 'unassigned',
            kind: 'acceptance',
          })),
        };
        value.store.saveDeliveryBlueprint(value.session.id, JSON.stringify(blueprint));
      }
      return ok(`Upserted ${saved.length} work item(s). The board remains active; no human approval was introduced.`);
    },
  };
}

export function appRequestDecision(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_request_decision',
    description: 'Ask one durable product/technical decision and block only the listed cards. Do not stop work on independent cards.',
    parameters: { type: 'object', properties: {
      question: { type: 'string' }, options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } }, required: ['label', 'value'] } },
      blocked_work_item_ids: { type: 'array', items: { type: 'string' } },
    }, required: ['question', 'blocked_work_item_ids'], additionalProperties: false } as JsonSchema,
    source: 'native', mutates: true, interactive: false,
    handler: async (args) => {
      const value = bound(binding); if (!value.ok) return err(value.error);
      const question = typeof args.question === 'string' ? args.question.trim() : '';
      const blockedIds = Array.isArray(args.blocked_work_item_ids) ? args.blocked_work_item_ids.map(String) : [];
      if (!question) return err('question is required.');
      for (const id of blockedIds) {
        if (!value.store.getWorkItem(value.session.id, id)) return err(`Unknown blocked work item '${id}'.`);
        value.store.setWorkItemStatus(value.session.id, id, 'blocked', { blockedReason: question });
      }
      const decision = value.store.createDecisionRequest({ sessionId: value.session.id, question, optionsJson: JSON.stringify(args.options ?? []), blockedWorkItemIdsJson: JSON.stringify(blockedIds) });
      return ok(`Decision ${decision.id} requested. Only ${blockedIds.length} linked card(s) are blocked; continue independent ready work.`);
    },
  };
}

export function appRequestApproval(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_request_approval',
    description: 'Request one of the only three async human approvals: scope, blueprint or release. Validates its deterministic gate and never pauses the runner.',
    parameters: { type: 'object', properties: {
      type: { type: 'string', enum: ['scope', 'blueprint', 'release'] }, summary: { type: 'string' },
    }, required: ['type', 'summary'], additionalProperties: false } as JsonSchema,
    source: 'native', mutates: true, interactive: false,
    handler: async (args) => {
      const value = bound(binding); if (!value.ok) return err(value.error);
      const type = String(args.type) as AppApproval['type'];
      const pendingSpec = value.store.getPendingSpecRevision(value.session.id);
      const spec = parseAppSpec(pendingSpec?.spec_json ?? value.session.spec_json);
      const productRow = value.store.getLatestProductRevision(value.session.id);
      const product = parseAppProductModel(productRow?.product_json);
      const items = value.store.listWorkItems(value.session.id).map(hydrateItem);
      const bundle = {
        spec_revision_id: pendingSpec?.id ?? value.store.getLatestApprovedSpecRevision(value.session.id)?.id ?? null,
        product_revision_id: productRow?.id ?? null,
        architecture_revision_id: value.store.getLatestArchitectureRevision(value.session.id)?.id ?? null,
        ux_revision_id: value.store.getLatestUxRevision(value.session.id)?.id ?? null,
        wireframe_revision_id: value.store.getLatestWireframeRevision(value.session.id)?.id ?? null,
        delivery_blueprint_id: value.store.getLatestDeliveryBlueprint(value.session.id)?.id ?? null,
      };
      const issues: string[] = [];
      if (type === 'scope') {
        if (!spec) issues.push('No app spec saved.');
        else issues.push(...auditAppSpec(spec).issues.filter((issue) => issue.severity === 'error').map((issue) => issue.detail));
        issues.push(...auditAppProductModel(product).issues);
      } else if (type === 'blueprint') {
        const blueprint = json<AppDeliveryBlueprint | null>(value.store.getLatestDeliveryBlueprint(value.session.id)?.blueprint_json, null);
        issues.push(...auditAppDeliveryBlueprint(blueprint, spec, product, items).issues);
      } else {
        const blueprint = json<AppDeliveryBlueprint | null>(value.store.getLatestDeliveryBlueprint(value.session.id)?.blueprint_json, null);
        issues.push(...auditAppReleaseReadiness(items, blueprint).issues);
      }
      if (issues.length) return err(`Cannot request ${type} approval:\n- ${[...new Set(issues)].join('\n- ')}`);
      const revision = Math.max(0, ...value.store.listApprovals(value.session.id).filter((item) => item.type === type).map((item) => item.bundle_revision)) + 1;
      const approval = value.store.requestApproval({ sessionId: value.session.id, type, bundleRevision: revision, bundleJson: JSON.stringify(bundle), summary: String(args.summary) });
      return ok(`Approval ${approval.id} (${type}) is pending asynchronously. Do NOT stop: continue independent ready cards and use app_get_workflow for current state.`);
    },
  };
}

export function appDispatchReadyWork(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_dispatch_ready_work',
    description: 'Plan dependency-safe adaptive waves from ready Kanban cards and seed the existing execute_tasks runtime as already approved. Call execute_tasks({mode:"auto"}) immediately after.',
    parameters: EMPTY, source: 'native', mutates: true, parallelSafe: false,
    handler: async (_args, ctx) => {
      const value = bound(binding); if (!value.ok) return err(value.error);
      const items = value.store.refreshReadyWorkItems(value.session.id).map(hydrateItem);
      const agentConfig = parseAppAgentConfig(value.session.agent_config_json);
      const waves = planAdaptiveDispatch(items);
      if (waves.length === 0) return ok('No dependency-ready cards. Resolve the listed decision/approval blockers or create the missing cards.');
      const dispatches = waves.flat();
      const dispatchById = new Map(dispatches.map((item) => [item.work_item_id, item]));
      const selectedIds = dispatches.map((item) => item.work_item_id);
      const selected = selectedIds.map((id) => items.find((item) => item.id === id)!).filter(Boolean);
      const tasks: CoderTask[] = selected.map((item) => {
        const profileConfig = agentConfig.profiles[item.owner_profile];
        const coordinatorInstruction = agentConfig.coordinator_prompt
          ? `\nCoordinator instructions: ${agentConfig.coordinator_prompt}`
          : '';
        const profileInstruction = profileConfig?.additional_prompt
          ? `\nProfile instructions (${item.owner_profile}): ${profileConfig.additional_prompt}`
          : '';
        const requiredSkills = profileConfig?.skills ?? [];
        const skillInstruction = requiredSkills.length > 0
          ? `\nRequired skills (${item.owner_profile}): ${requiredSkills.join(', ')}. Load each assigned skill with get_skill_content before executing this card.`
          : '';
        const mode = profileConfig?.enabled === false ? 'inline' : (dispatchById.get(item.id)?.mode ?? 'subagent');
        return {
          id: item.id, title: item.title,
          description: `${item.outcome}\nAcceptance: ${item.acceptance.join('; ')}${coordinatorInstruction}${profileInstruction}${skillInstruction}\nAfter execution call app_record_work_evidence for this card.`,
          files: item.file_scope, references: item.source_ids.map((source) => ({ type: 'doc' as const, value: source })),
          depends_on: item.depends_on.filter((id) => selectedIds.includes(id)),
          suggested_mode: mode,
          estimated_complexity: item.file_scope.length > 5 ? 'large' : item.file_scope.length > 1 ? 'medium' : 'small',
          parallel_group: `app-wave-${waves.findIndex((wave) => wave.some((candidate) => candidate.work_item_id === item.id)) + 1}`,
          kind: item.kind === 'research' || item.kind === 'plan' ? 'investigate' : item.kind === 'verify' || item.kind === 'release' ? 'verify' : 'implement',
          agent_profile: item.owner_profile,
          status: 'pending',
        };
      });
      const taskState: TasksState = { gate: 'approve', summary: 'App Studio ready work', tasks, execution_mode: 'smart', approved: true, current_task_id: null };
      ctx.recordTasks?.(ctx.currentToolUseId ?? `app-dispatch:${Date.now()}`, taskState);
      ctx.resolveTasks?.({ approved: true, tasks, execution_mode: 'smart' });
      for (const item of selected) {
        const profileConfig = agentConfig.profiles[item.owner_profile];
        value.store.setWorkItemStatus(value.session.id, item.id, 'running', { runJson: JSON.stringify({
          mode: profileConfig?.enabled === false ? 'inline' : (dispatchById.get(item.id)?.mode ?? 'subagent'),
          agent: profileConfig?.enabled === false ? 'coordinator' : (dispatchById.get(item.id)?.profile ?? item.owner_profile),
        }) });
      }
      return ok(`Prepared ${tasks.length} already-approved task(s) in ${waves.length} dependency/file-safe wave(s). Call execute_tasks({mode:"auto"}) now; no additional human task approval is needed.`);
    },
  };
}

export function appRecordWorkEvidence(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_record_work_evidence',
    description: 'Attach concrete proof to a Kanban card and move it to automated review or done. Done is rejected without evidence.',
    parameters: { type: 'object', properties: {
      work_item_id: { type: 'string' }, status: { type: 'string', enum: ['review', 'done', 'blocked'] },
      summary: { type: 'string' }, evidence: { type: 'array', minItems: 1, items: { type: 'object', properties: { kind: { type: 'string' }, value: { type: 'string' } }, required: ['kind', 'value'] } },
      blocked_reason: { type: 'string' },
    }, required: ['work_item_id', 'status', 'summary'], additionalProperties: false } as JsonSchema,
    source: 'native', mutates: true,
    handler: async (args) => {
      const value = bound(binding); if (!value.ok) return err(value.error);
      const id = String(args.work_item_id ?? '');
      const current = value.store.getWorkItem(value.session.id, id);
      if (!current) return err(`Unknown work item '${id}'.`);
      if (current.status === 'cancelled') return err(`Work item '${id}' was cancelled and cannot accept new evidence.`);
      if (current.status === 'blocked' || current.status === 'stale') return err(`Work item '${id}' is ${current.status}; resume or replace it before recording evidence.`);
      const evidence = Array.isArray(args.evidence) ? args.evidence.map((item) => {
        const record = item as Record<string, unknown>;
        return { kind: typeof record.kind === 'string' ? record.kind : '', value: typeof record.value === 'string' ? record.value : '', recorded_at: new Date().toISOString() };
      }) : [];
      if (String(args.status) !== 'blocked' && evidence.length === 0) return err('At least one concrete evidence item is required.');
      if (evidence.some((item) => !item.kind.trim() || !item.value.trim())) {
        return err('Every evidence item needs a non-empty kind and value.');
      }
      if ((current.kind === 'implement' || current.kind === 'contract') && String(args.status) === 'done') {
        return err(`Work item '${id}' must move to review. A separate verify card must complete it.`);
      }
      const merged = [...json<unknown[]>(current.evidence_json, []), ...evidence];
      const item = value.store.setWorkItemStatus(value.session.id, id, String(args.status) as AppWorkItemStatus, {
        blockedReason: typeof args.blocked_reason === 'string' ? args.blocked_reason : null,
        evidenceJson: JSON.stringify(merged), runJson: JSON.stringify({ ...json(current.run_json, {}), summary: String(args.summary) }),
      });
      const resolveCorrection = (corrector: AppStudioWorkItem, verifierId?: string): void => {
        const run = json<{ corrects_work_item_id?: string }>(corrector.run_json, {});
        if (!run.corrects_work_item_id) return;
        const corrected = value.store.getWorkItem(value.session.id, run.corrects_work_item_id);
        if (!corrected || corrected.status !== 'stale') return;
        const correctedEvidence = json<Array<{ kind: string; value: string; recorded_at?: string }>>(corrected.evidence_json, []);
        const recordedAt = new Date().toISOString();
        value.store.setWorkItemStatus(value.session.id, corrected.id, 'done', {
          evidenceJson: JSON.stringify([
            ...correctedEvidence,
            { kind: 'corrected-by', value: corrector.id, recorded_at: recordedAt },
            ...(verifierId ? [{ kind: 'verified-by', value: verifierId, recorded_at: recordedAt }] : []),
          ]),
        });
        const all = value.store.listWorkItems(value.session.id).map(hydrateItem);
        for (const dependentId of dependentWorkItemIds(all, [corrected.id])) {
          if (dependentId === corrected.id) continue;
          const dependent = value.store.getWorkItem(value.session.id, dependentId);
          if (dependent?.status === 'stale') value.store.setWorkItemStatus(value.session.id, dependent.id, 'backlog');
        }
      };
      if (current.kind === 'verify' && item.status === 'done') {
        for (const dependencyId of json<string[]>(current.depends_on_json, [])) {
          const dependency = value.store.getWorkItem(value.session.id, dependencyId);
          if (!dependency || dependency.status !== 'review') continue;
          const dependencyEvidence = json<unknown[]>(dependency.evidence_json, []);
          value.store.setWorkItemStatus(value.session.id, dependency.id, 'done', {
            evidenceJson: JSON.stringify([...dependencyEvidence, { kind: 'verified-by', value: current.id, recorded_at: new Date().toISOString() }]),
          });
          resolveCorrection(dependency, current.id);
        }
      }
      if (item.status === 'done' && current.kind !== 'implement' && current.kind !== 'contract') resolveCorrection(item, current.kind === 'verify' ? current.id : undefined);
      value.store.refreshReadyWorkItems(value.session.id);
      return ok(`Work item '${item.id}' moved to ${item.status} with ${merged.length} evidence record(s).`);
    },
  };
}
