/**
 * API client do App Studio (rotas /api/app-studio/...). Espelha a
 * convenção do design-system-api: wrappers tipados sobre fetch, Error em
 * non-2xx; criação via POST JSON que responde stream SSE
 * (start/phase/log/done/error — parse manual, EventSource não faz POST).
 */

export type AppStageId = 'discovery' | 'architecture' | 'database' | 'design' | 'backend' | 'review' | 'launch';
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
  architecture: AppArchitectureView | null;
  deploy: AppDeployView | null;
  features: Array<{ id: number; name: string; kind: string; summary: string | null; verified_in_preview: boolean }>;
}

export interface AppPipelineRepairReport {
  changed: boolean;
  issues: Array<{
    code: string;
    severity: 'warning' | 'error';
    stage_id: AppStageId | null;
    message: string;
  }>;
  changes: Array<{
    stage_id: AppStageId | null;
    before: AppStageStatus | 'missing' | 'outdated';
    after: AppStageStatus | 'rebuilt';
    reason: string;
  }>;
  pipeline: {
    v: 2;
    stages: AppPipelineStage[];
    roadmap: Array<{ name: string; tier: AppRoadmapTier; feature_id: string | null; source: 'spec' }>;
  };
}

export interface AppPipelineRepairPreview {
  preview_token: string;
  report: AppPipelineRepairReport;
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

export async function initAppPipeline(sessionId: number): Promise<void> {
  await unwrap(await fetch(`/api/app-studio/sessions/${sessionId}/pipeline/init`, { method: 'POST' }));
}

export async function previewAppPipelineRepair(sessionId: number): Promise<AppPipelineRepairPreview> {
  return unwrap(await fetch(`/api/app-studio/sessions/${sessionId}/pipeline/repair/preview`, { method: 'POST' }));
}

export async function applyAppPipelineRepair(
  sessionId: number,
  previewToken: string,
): Promise<{ report: AppPipelineRepairReport; repair_id: number | null }> {
  return unwrap(
    await fetch(`/api/app-studio/sessions/${sessionId}/pipeline/repair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preview_token: previewToken }),
    }),
  );
}

export async function undoAppPipelineRepair(sessionId: number, repairId: number): Promise<void> {
  await unwrap(
    await fetch(`/api/app-studio/sessions/${sessionId}/pipeline/repair/${repairId}/undo`, { method: 'POST' }),
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
