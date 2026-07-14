/**
 * API client do App Studio (rotas /api/app-studio/...). Espelha a
 * convenção do design-system-api: wrappers tipados sobre fetch, Error em
 * non-2xx; criação via POST JSON que responde stream SSE
 * (start/phase/log/done/error — parse manual, EventSource não faz POST).
 */

export type AppWorkflowPhaseId = 'define' | 'blueprint' | 'build' | 'deliver';
export type AppWorkflowPhaseStatus = 'locked' | 'active' | 'attention' | 'complete';
export type AppWorkItemStatus = 'backlog' | 'ready' | 'running' | 'review' | 'done' | 'blocked' | 'stale' | 'cancelled';
export type AppApprovalType = 'scope' | 'blueprint' | 'release';

export interface AppStudioSession {
  id: number;
  project_id: number;
  name: string;
  app_slug: string;
  stack: 'cf-fullstack';
  db_engine: 'd1' | 'postgres' | 'mysql';
  spec_json: string | null;
  deploy_json: string | null;
  /** Layout do canvas Blueprint (mig 201). */
  blueprint_json: string | null;
  coordinator_session_id: number | null;
  created_at: string;
}

export interface AppWorkflowBundleRefs {
  spec_revision_id?: number | null;
  product_revision_id?: number | null;
  architecture_revision_id?: number | null;
  ux_revision_id?: number | null;
  wireframe_revision_id?: number | null;
  delivery_blueprint_id?: number | null;
}

export interface AppWorkItemView {
  id: string; app_session_id: number; phase: AppWorkflowPhaseId; slice_id: string | null;
  title: string; outcome: string; kind: 'research' | 'plan' | 'contract' | 'implement' | 'verify' | 'release' | 'change';
  owner_profile: string; priority: number; revision: number; status: AppWorkItemStatus; sort_order: number;
  depends_on: string[]; source_ids: string[]; acceptance: string[];
  evidence: Array<{ kind: string; value: string; recorded_at?: string }>;
  file_scope: string[]; blocked_reason: string | null;
  run: { mode?: 'inline' | 'subagent'; run_id?: string; agent?: string } | null;
  created_at: string; updated_at: string;
}

export interface AppApprovalView {
  id: number; app_session_id: number; type: AppApprovalType;
  status: 'pending' | 'approved' | 'changes_requested' | 'superseded';
  bundle_revision: number; bundle: AppWorkflowBundleRefs; summary: string; feedback: string | null;
  requested_at: string; resolved_at: string | null;
}

export interface AppDecisionRequestView {
  id: number; app_session_id: number; question: string;
  options: Array<{ label: string; value: string }>;
  blocked_work_item_ids: string[]; status: 'open' | 'resolved'; answer: string | null;
  requested_at: string; resolved_at: string | null;
}

export interface AppWorkflowView {
  state: {
    v: 5;
    phases: Array<{ id: AppWorkflowPhaseId; status: AppWorkflowPhaseStatus; bundle: AppWorkflowBundleRefs }>;
    release_unlocked: boolean;
    migrated_from: number | null;
    migrated_at: string | null;
  };
  work_items: AppWorkItemView[];
  approvals: AppApprovalView[];
  decisions: AppDecisionRequestView[];
  blueprint: { v: 1; refs: AppWorkflowBundleRefs; slices: unknown[]; test_matrix: unknown[] } | null;
  coordinator_session_id: number | null;
  attention: { approval_ids: number[]; decision_ids: number[] };
}

export interface AppSpecView {
  v: 1 | 2;
  summary: string;
  audience: string;
  locale: string;
  features: Array<{ id: string; name: string; description: string; screen_ids: string[] }>;
  screens: Array<{ id: string; name: string; label: string; purpose: string; primary?: boolean }>;
  database: {
    required: boolean;
    entities: Array<{
      name: string;
      label: string;
      fields: Array<{ name: string; label: string; type: string; required?: boolean; references?: string }>;
    }>;
  };
  auth: { enabled: boolean; methods?: string[]; protected_screen_ids?: string[] };
  design: { tone: string; primary_color?: string };
  requirements?: {
    goals?: string[];
    business_rules?: string[];
    acceptance_criteria?: string[];
    out_of_scope?: string[];
    assumptions?: string[];
    risks?: string[];
  };
  requirement_ids?: Partial<Record<'goal' | 'rule' | 'acceptance' | 'out-of-scope' | 'assumption' | 'risk', string[]>>;
  behaviors?: Array<{
    id: string;
    screen_id: string;
    trigger: 'click' | 'submit' | 'open';
    trigger_label: string;
    actions: Array<
      | { kind: 'save'; entity: string }
      | { kind: 'navigate'; screen_id: string }
      | { kind: 'notify'; message: string }
    >;
  }>;
}

export interface AppDeployView {
  url?: string | null;
  health_ok?: boolean;
  database_id?: string | null;
  account?: string | null;
  deployed_at?: string | null;
}

export interface AppStudioListEntry extends AppStudioSession {
  project: { id: number; name: string; root_path: string } | null;
  builder_port: number | null;
  current_phase: AppWorkflowPhaseId | null;
  current_phase_status: AppWorkflowPhaseStatus | null;
  phase_total: number;
  phase_done: number;
  live_url: string | null;
}

export interface AppStudioSessionDetail {
  session: AppStudioSession;
  project: { id: number; name: string; root_path: string } | null;
  builder_port: number | null;
  workflow: AppWorkflowView;
  spec: AppSpecView | null;
  product: AppProductView | null;
  architecture: AppArchitectureView | null;
  ux: AppUxView | null;
  wireframe: AppWireframeView | null;
  deploy: AppDeployView | null;
}

export interface AppProductCapabilityView {
  id: string; domain_id: string; name: string; description: string;
  horizon: 'core' | 'complete' | 'future' | 'declined'; provenance: 'user' | 'inferred' | 'researched' | 'existing';
  selected: boolean; critical: boolean; rationale: string; actor_ids: string[]; rule_ids: string[];
  entity_names: string[]; screen_ids: string[]; quality_attributes: string[]; research_source_ids: string[];
}

export interface AppProductView {
  id: number; revision_number: number; base_spec_revision_id: number | null; result_spec_revision_id: number | null;
  status: 'draft' | 'approved' | 'superseded' | 'rejected'; created_at: string; updated_at: string; approved_at: string | null;
  fingerprint: string;
  audit: { ok: boolean; issues: string[]; warnings: string[]; counts: { domains: number; capabilities: number; selected: number; scenarios: number; open_decisions: number } };
  model: {
    v: 1; summary: string; complexity: 'simple' | 'standard' | 'complex' | 'very-complex'; complexity_factors: string[];
    personas: Array<{ id: string; name: string; goals: string[]; permissions: string[] }>;
    domains: Array<{ id: string; name: string; description: string; capability_ids: string[] }>;
    capabilities: AppProductCapabilityView[];
    scenarios: Array<{ id: string; capability_id: string; kind: string; title: string; given: string[]; when: string; then: string[]; source_ids: string[] }>;
    journeys: Array<{ id: string; name: string; actor_id: string; capability_ids: string[]; outcome: string }>;
    non_functional_requirements: string[]; assumptions: string[]; risks: string[];
    decisions: Array<{ id: string; question: string; status: 'open' | 'decided'; blocking: boolean; decision: string | null }>;
    research_sources: Array<{ id: string; title: string; url: string; publisher: string; accessed_at: string; supports_capability_ids: string[] }>;
  };
}

export interface AppUxView {
  id: number;
  revision_number: number;
  spec_revision_id: number | null;
  architecture_revision_id: number | null;
  data_fingerprint: string;
  status: 'draft' | 'approved' | 'superseded' | 'rejected';
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  audit: { ok: boolean; issues: string[] };
  brief: {
    v: 1;
    summary: string;
    selected_direction_id: string;
    directions: Array<{ id: string; name: string; rationale: string; palette: string[]; typography: string; density: 'compact' | 'comfortable' | 'spacious' }>;
    tokens: Record<string, string> & { density: 'compact' | 'comfortable' | 'spacious' };
    navigation: string;
    principles: string[];
    constraints: string[];
    rejected_directions: string[];
    accessibility: { standard: string; contrast: string; keyboard: string; focus: string; reduced_motion: string };
    references: Array<{ kind: 'image' | 'url' | 'design-system'; value: string; note: string }>;
  };
}

export interface AppWireframeView {
  id: number;
  revision_number: number;
  spec_revision_id: number | null;
  architecture_revision_id: number | null;
  ux_revision_id: number | null;
  data_fingerprint: string;
  status: 'draft' | 'approved' | 'superseded' | 'rejected';
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  audit: { ok: boolean; issues: string[] };
  plan: {
    v: 2;
    summary: string;
    flows: Array<{ id: string; name: string; actor: string; goal: string; entry_screen_id: string; source_ids: string[]; steps: Array<{ id: string; screen_id: string; action: string; result: string; reads: string[]; writes: string[]; next_step_ids: string[] }> }>;
    screens: Array<{ screen_id: string; route: string; flow_ids: string[]; hierarchy: string[]; regions: Array<{ id: string; purpose: string; components: string[] }>; actions: string[]; data_bindings: Array<{ entity: string; fields: string[]; purpose: string; fixture_scenario: string }>; states: string[]; responsive: string; accessibility: string[] }>;
    tdd_cases: Array<{ id: string; title: string; architecture_case_ids: string[]; source_ids: string[]; flow_ids: string[]; screen_ids: string[]; preconditions: string[]; steps: string[]; expected: string }>;
    delivery_slices: Array<{ id: string; name: string; goal: string; sequence: number; complexity: 'small' | 'medium' | 'large'; flow_ids: string[]; capability_ids: string[]; screen_ids: string[]; depends_on: string[]; checklist_item_ids: string[] }>;
    checklist_items: Array<{ id: string; slice_id: string; screen_id: string | null; kind: string; title: string; sequence: number; complexity: 'small' | 'medium' | 'large'; depends_on: string[]; tdd_case_ids: string[]; entity_names: string[]; source_ids: string[] }>;
  };
}

export interface AppArchitectureView {
  id: number;
  revision_number: number;
  spec_revision_id: number | null;
  status: 'draft' | 'approved' | 'superseded' | 'rejected';
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  audit: { ok: boolean; issues: string[]; required_source_ids: string[]; covered_source_ids: string[] };
  plan: {
    v: 1;
    spec_revision_id: number | null;
    stack_profile_id: 'cf-fullstack-v1';
    summary: string;
    modules: Array<{ id: string; name: string; layer: 'ui' | 'worker' | 'data' | 'cross-cutting'; responsibility: string; depends_on: string[] }>;
    decisions: Array<{ id: string; title: string; decision: string; rationale: string; source_urls: string[] }>;
    data_flow: string[];
    security: string[];
    observability: string[];
    risks: Array<{ id: string; title: string; mitigation: string; severity: 'low' | 'medium' | 'high' }>;
    sources: Array<{ title: string; url: string; checked_at: string; notes: string }>;
    tdd: {
      strategy: string;
      cases: Array<{
        id: string;
        title: string;
        layer: 'database' | 'worker' | 'browser' | 'e2e';
        owner_profile: 'data' | 'ui' | 'api' | 'verify';
        priority: 'critical' | 'important' | 'supporting';
        source_ids: string[];
        preconditions: string[];
        steps: string[];
        expected: string;
      }>;
    };
  };
}

export interface AppSpecImpactView {
  level: 'none' | 'low' | 'medium' | 'high';
  affected_phases: AppWorkflowPhaseId[];
  source_ids: string[];
  reasons: string[];
}

export interface AppSpecRevisionView {
  id: number;
  app_session_id: number;
  revision_number: number;
  base_revision_id: number | null;
  status: 'draft' | 'approved' | 'superseded' | 'rejected';
  title: string | null;
  summary: string | null;
  change_reason: string | null;
  diff_json?: never;
  impact_json?: never;
  diff: unknown | null;
  impact: AppSpecImpactView | null;
  spec_summary: {
    summary: string;
    screens: number;
    entities: number;
    features: number;
    behaviors: number;
  } | null;
  created_by: string;
  coder_session_id: number | null;
  created_at: string;
  approved_at: string | null;
}

export interface AppEvolutionView {
  id: number;
  app_session_id: number;
  base_revision_id: number | null;
  proposed_revision_id: number | null;
  title: string;
  description: string | null;
  status: 'draft' | 'review' | 'approved' | 'applied' | 'rejected';
  impact_json?: never;
  impact: AppSpecImpactView | null;
  created_at: string;
  submitted_at: string | null;
  approved_at: string | null;
  applied_at: string | null;
}

export interface AppSpecHistoryView {
  current_revision_id: number | null;
  revisions: AppSpecRevisionView[];
  evolutions: AppEvolutionView[];
}

async function unwrap<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = r.statusText;
    try {
      msg = ((await r.json()) as { error?: string }).error ?? msg;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`${r.status}: ${msg}`);
  }
  return (await r.json()) as T;
}

export async function listAppStudioSessions(): Promise<AppStudioListEntry[]> {
  const data = await unwrap<{ sessions: AppStudioListEntry[] }>(await fetch('/api/app-studio/sessions'));
  return data.sessions;
}

export async function getAppStudioSession(id: number): Promise<AppStudioSessionDetail> {
  return unwrap(await fetch(`/api/app-studio/sessions/${id}`));
}

export interface AppAgentProfileConfigView {
  enabled: boolean;
  additional_prompt: string;
  skills: string[];
}

export interface AppAgentConfigView {
  v: 1;
  coordinator_prompt: string;
  coordinator_skills: string[];
  profiles: Record<string, AppAgentProfileConfigView>;
}

export interface AppAgentSkillView {
  id: string;
  name: string;
  description: string;
  slash_command: string | null;
  context_mode: string;
  source: string;
  author: string | null;
}

export interface AppAgentToolCallView {
  id: number;
  seq: number;
  turn: number | null;
  tool_name: string;
  productive: 0 | 1;
  is_error: 0 | 1;
  refusal_kind: string | null;
  duration_ms: number;
  result_chars: number;
  created_at: string;
}

export interface AppAgentRunView {
  id: number;
  run_id: string;
  parent_run_id: string | null;
  spawn_id: string | null;
  profile: string;
  label: string | null;
  task_preview: string | null;
  reason: string | null;
  turns: number;
  tool_calls: number;
  productive_operations: number;
  error_calls: number;
  refused_calls: number;
  elapsed_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  started_at: string;
  completed_at: string | null;
  tool_calls_detail: AppAgentToolCallView[];
}

export interface AppAgentOverviewView {
  config: AppAgentConfigView;
  coordinator: null | {
    id: number;
    title: string;
    status: 'idle' | 'running' | 'error';
    provider: string;
    model: string;
    agent: string | null;
    total_input_tokens: number;
    total_output_tokens: number;
    last_turn_input_tokens: number;
    tool_permission_mode: 'ask' | 'auto' | 'unrestricted' | null;
    reasoning_effort: string | null;
    created_at: string;
    updated_at: string;
  };
  profiles: Array<{
    name: string;
    enabled: boolean;
    additional_prompt: string;
    skills: string[];
    cards: number;
    active_cards: number;
    runs: number;
  }>;
  runs: AppAgentRunView[];
  available_skills: AppAgentSkillView[];
}

export async function patchAppProductScope(
  sessionId: number,
  input: { expected_revision_number: number; selections: Array<{ capability_id: string; selected: boolean; horizon?: AppProductCapabilityView['horizon'] }> },
): Promise<{ model: AppProductView['model']; audit: AppProductView['audit'] }> {
  return unwrap(await fetch(`/api/app-studio/sessions/${sessionId}/product`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }));
}

export async function getAppWorkflow(sessionId: number): Promise<AppWorkflowView> {
  const result = await unwrap<{ workflow: AppWorkflowView }>(await fetch(`/api/app-studio/sessions/${sessionId}/workflow`));
  return result.workflow;
}

export async function resolveAppApproval(
  sessionId: number,
  approvalId: number,
  decision: 'approve' | 'request_changes',
  input: { feedback?: string; source_ids?: string[] } = {},
): Promise<AppWorkflowView> {
  const result = await unwrap<{ workflow: AppWorkflowView }>(await fetch(`/api/app-studio/sessions/${sessionId}/approvals/${approvalId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `ui:${sessionId}:${approvalId}:${decision}` },
    body: JSON.stringify({ decision, ...input }),
  }));
  return result.workflow;
}

export async function updateAppWorkItem(
  sessionId: number,
  workItemId: string,
  input: { action: 'reorder' | 'pause' | 'resume' | 'cancel' | 'request_changes'; sort_order?: number; feedback?: string },
): Promise<AppWorkflowView> {
  const result = await unwrap<{ workflow: AppWorkflowView }>(await fetch(`/api/app-studio/sessions/${sessionId}/work-items/${encodeURIComponent(workItemId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }));
  return result.workflow;
}

export async function resolveAppDecision(sessionId: number, decisionId: number, answer: string): Promise<AppWorkflowView> {
  const result = await unwrap<{ workflow: AppWorkflowView }>(await fetch(`/api/app-studio/sessions/${sessionId}/decisions/${decisionId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer }),
  }));
  return result.workflow;
}

export async function deleteAppStudioSession(sessionId: number): Promise<void> {
  await unwrap(await fetch(`/api/app-studio/sessions/${sessionId}`, { method: 'DELETE' }));
}

export async function getAppSpecHistory(sessionId: number): Promise<AppSpecHistoryView> {
  return unwrap(await fetch(`/api/app-studio/sessions/${sessionId}/revisions`));
}

export async function createAppEvolution(
  sessionId: number,
  input: { title: string; description?: string | null },
): Promise<{ evolution: AppEvolutionView; base_revision: AppSpecRevisionView | null }> {
  return unwrap(
    await fetch(`/api/app-studio/sessions/${sessionId}/evolutions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

/** Discard an empty draft evolution (409 if it already has a proposed revision). */
export async function deleteAppEvolution(sessionId: number, evolutionId: number): Promise<{ deleted_id: number }> {
  return unwrap(
    await fetch(`/api/app-studio/sessions/${sessionId}/evolutions/${evolutionId}`, { method: 'DELETE' }),
  );
}

export async function getAppAgentOverview(sessionId: number): Promise<AppAgentOverviewView> {
  return unwrap(await fetch(`/api/app-studio/sessions/${sessionId}/agents`));
}

export async function saveAppAgentConfig(sessionId: number, config: AppAgentConfigView): Promise<AppAgentConfigView> {
  const result = await unwrap<{ config: AppAgentConfigView }>(await fetch(`/api/app-studio/sessions/${sessionId}/agents/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  }));
  return result.config;
}

export async function saveAppAgentRuntime(sessionId: number, input: { provider: string; model: string; reasoning_effort: string | null }): Promise<{ provider: string; model: string; reasoning_effort: string | null }> {
  const result = await unwrap<{ runtime: { provider: string; model: string; reasoning_effort: string | null } }>(await fetch(`/api/app-studio/sessions/${sessionId}/agents/runtime`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }));
  return result.runtime;
}

export async function proposeAppEvolution(
  sessionId: number,
  evolutionId: number,
  input: { spec: AppSpecView; title?: string; summary?: string; change_reason?: string },
): Promise<{ evolution: AppEvolutionView; revision: AppSpecRevisionView; impact: AppSpecImpactView }> {
  return unwrap(await fetch(`/api/app-studio/sessions/${sessionId}/evolutions/${evolutionId}/propose`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }));
}

// ── Criação (SSE) ────────────────────────────────────────────────────

export interface AppStudioCreated {
  project: { id: number; name: string; root_path: string };
  app_session: AppStudioSession;
  coder_session_id: number;
}

export async function createAppStudio(
  input: { name: string; provider: string; model: string; reasoning_effort?: string | null },
  handlers: {
    onPhase?: (phase: string, label: string) => void;
    onLog?: (stream: 'stdout' | 'stderr', chunk: string) => void;
  } = {},
): Promise<AppStudioCreated> {
  const r = await fetch('/api/app-studio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!r.ok || !r.body) {
    let msg = r.statusText;
    try {
      msg = ((await r.json()) as { error?: string }).error ?? msg;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`${r.status}: ${msg}`);
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) continue;
      const data = dataLines.join('\n');
      if (event === 'phase') {
        const d = JSON.parse(data) as { phase: string; label: string };
        handlers.onPhase?.(d.phase, d.label);
      } else if (event === 'log') {
        const d = JSON.parse(data) as { stream: 'stdout' | 'stderr'; chunk: string };
        handlers.onLog?.(d.stream, d.chunk);
      } else if (event === 'error') {
        const d = JSON.parse(data) as { message: string; stderrTail?: string };
        throw new Error(d.stderrTail ? `${d.message}\n${d.stderrTail}` : d.message);
      } else if (event === 'done') {
        return JSON.parse(data) as AppStudioCreated;
      }
    }
  }
  throw new Error('Scaffold stream ended without a done event.');
}
