/**
 * API client do App Studio (rotas /api/app-studio/...). Espelha a
 * convenção do design-system-api: wrappers tipados sobre fetch, Error em
 * non-2xx; criação via POST JSON que responde stream SSE
 * (start/phase/log/done/error — parse manual, EventSource não faz POST).
 */

export type AppStageId = 'discovery' | 'product' | 'architecture' | 'database' | 'ux' | 'wireframe' | 'design' | 'backend' | 'review' | 'launch';
export type AppStageStatus = 'pending' | 'active' | 'review' | 'approved' | 'skipped';
export type AppStageAction = 'start' | 'approve' | 'reopen' | 'skip';
export type AppRoadmapTier = 'screen' | 'api';

export interface AppStudioSession {
  id: number;
  project_id: number;
  name: string;
  app_slug: string;
  stack: 'cf-fullstack';
  db_engine: 'd1' | 'postgres' | 'mysql';
  spec_json: string | null;
  pipeline_json: string | null;
  deploy_json: string | null;
  /** Layout do canvas Blueprint (mig 201). */
  blueprint_json: string | null;
  created_at: string;
}

export interface AppPipelineStage {
  id: AppStageId;
  status: AppStageStatus;
  summary: string | null;
  gate: { ok: boolean; issues: string[] } | null;
  feedback: string | null;
  submitted_at: string | null;
  approved_at: string | null;
}

export interface AppPipelineView {
  stages: AppPipelineStage[];
  current_stage: AppStageId | null;
  roadmap: Array<{ name: string; tier: AppRoadmapTier; feature_id: string | null; recorded: boolean }>;
}

export interface AppSpecView {
  v: 1;
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
  current_stage: AppStageId | null;
  current_stage_status: AppStageStatus | null;
  stage_total: number;
  stage_done: number;
  live_url: string | null;
}

export interface AppStudioSessionDetail {
  session: AppStudioSession;
  project: { id: number; name: string; root_path: string } | null;
  builder_port: number | null;
  pipeline: AppPipelineView | null;
  spec: AppSpecView | null;
  product: AppProductView | null;
  architecture: AppArchitectureView | null;
  ux: AppUxView | null;
  wireframe: AppWireframeView | null;
  build_groups: AppBuildGroupView[];
  build_tasks: AppBuildTaskEvidenceView[];
  deploy: AppDeployView | null;
  features: Array<{ id: number; name: string; kind: string; summary: string | null; verified_in_preview: boolean }>;
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
    v: 1;
    summary: string;
    flows: Array<{ id: string; name: string; actor: string; goal: string; entry_screen_id: string; source_ids: string[]; steps: Array<{ id: string; screen_id: string; action: string; result: string; reads: string[]; writes: string[]; next_step_ids: string[] }> }>;
    screens: Array<{ screen_id: string; route: string; flow_ids: string[]; hierarchy: string[]; regions: Array<{ id: string; purpose: string; components: string[] }>; actions: string[]; data_bindings: Array<{ entity: string; fields: string[]; purpose: string; fixture_scenario: string }>; states: string[]; responsive: string; accessibility: string[] }>;
    tdd_cases: Array<{ id: string; title: string; architecture_case_ids: string[]; source_ids: string[]; flow_ids: string[]; screen_ids: string[]; preconditions: string[]; steps: string[]; expected: string }>;
    build_groups: Array<{ id: string; name: string; goal: string; sequence: number; complexity: 'small' | 'medium' | 'large'; flow_ids: string[]; capability_ids: string[]; screen_ids: string[]; depends_on: string[]; task_ids: string[] }>;
    tasks: Array<{ id: string; group_id: string; screen_id: string | null; kind: string; title: string; sequence: number; complexity: 'small' | 'medium' | 'large'; depends_on: string[]; tdd_case_ids: string[]; entity_names: string[]; source_ids: string[] }>;
  };
}

export interface AppBuildGroupView { id: number; wireframe_revision_id: number; group_id: string; status: 'pending' | 'active' | 'review' | 'approved'; summary: string | null; feedback: string | null; submitted_at: string | null; approved_at: string | null }
export interface AppBuildTaskEvidenceView { id: number; wireframe_revision_id: number; task_id: string; status: 'pending' | 'active' | 'done'; summary: string | null; evidence_json: string | null; completed_at: string | null }

export interface AppRepairArea {
  id: 'workspace' | 'database' | 'pipeline';
  status: 'healthy' | 'repairable' | 'attention';
  issues: Array<{
    code: string;
    severity: 'warning' | 'error';
    message: string;
    repairable: boolean;
  }>;
  actions: Array<{ title: string; reason: string }>;
}

export interface AppRepairReport {
  changed: boolean;
  healthy: boolean;
  action_count: number;
  areas: AppRepairArea[];
  pipeline: {
    v: 2 | 3 | 4;
    stages: AppPipelineStage[];
    roadmap: Array<{ name: string; tier: AppRoadmapTier; feature_id: string | null; source: 'spec' }>;
  };
}

export interface AppRepairPreview {
  preview_token: string;
  report: AppRepairReport;
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
        owner_stage: 'database' | 'design' | 'backend' | 'review';
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
  stage_ids: AppStageId[];
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

export async function patchAppStage(
  sessionId: number,
  stageId: AppStageId,
  action: AppStageAction,
  feedback?: string,
): Promise<void> {
  await unwrap(
    await fetch(`/api/app-studio/sessions/${sessionId}/pipeline/stage`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage_id: stageId, action, feedback }),
    }),
  );
}

export async function recheckAppStage(sessionId: number, stageId: AppStageId): Promise<{ ready_for_review: boolean }> {
  return unwrap(
    await fetch(`/api/app-studio/sessions/${sessionId}/pipeline/stage/recheck`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage_id: stageId }),
    }),
  );
}

export async function initAppPipeline(sessionId: number): Promise<void> {
  await unwrap(await fetch(`/api/app-studio/sessions/${sessionId}/pipeline/init`, { method: 'POST' }));
}

export async function previewAppRepair(sessionId: number): Promise<AppRepairPreview> {
  return unwrap(await fetch(`/api/app-studio/sessions/${sessionId}/repair/preview`, { method: 'POST' }));
}

export async function applyAppRepair(
  sessionId: number,
  previewToken: string,
): Promise<{ report: AppRepairReport; repair_id: number | null }> {
  return unwrap(
    await fetch(`/api/app-studio/sessions/${sessionId}/repair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preview_token: previewToken }),
    }),
  );
}

export async function undoAppRepair(sessionId: number, repairId: number): Promise<void> {
  await unwrap(
    await fetch(`/api/app-studio/sessions/${sessionId}/repair/${repairId}/undo`, { method: 'POST' }),
  );
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

export async function applyAppEvolution(
  sessionId: number,
  evolutionId: number,
): Promise<{ impact: AppSpecImpactView; evolution: AppEvolutionView }> {
  return unwrap(
    await fetch(`/api/app-studio/sessions/${sessionId}/evolutions/${evolutionId}/apply`, { method: 'POST' }),
  );
}

export async function rejectAppEvolution(sessionId: number, evolutionId: number): Promise<{ evolution: AppEvolutionView }> {
  return unwrap(
    await fetch(`/api/app-studio/sessions/${sessionId}/evolutions/${evolutionId}/reject`, { method: 'POST' }),
  );
}

/** Discard an empty draft evolution (409 if it already has a proposed revision). */
export async function deleteAppEvolution(sessionId: number, evolutionId: number): Promise<{ deleted_id: number }> {
  return unwrap(
    await fetch(`/api/app-studio/sessions/${sessionId}/evolutions/${evolutionId}`, { method: 'DELETE' }),
  );
}

export async function patchBuildGroup(
  sessionId: number,
  groupId: string,
  action: 'approve' | 'reopen',
  feedback?: string,
): Promise<{ groups: AppBuildGroupView[]; tasks: AppBuildTaskEvidenceView[] }> {
  return unwrap(
    await fetch(`/api/app-studio/sessions/${sessionId}/build-groups/${encodeURIComponent(groupId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, feedback }),
    }),
  );
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
