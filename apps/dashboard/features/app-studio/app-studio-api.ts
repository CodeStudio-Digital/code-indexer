import type { AppFitnessReport, AppPlanRevisionStatus, AppPlanV1 } from '@mcp/app-studio/plan/types.js';

export type AppStage = 'planning' | 'building' | 'reviewing' | 'ready' | 'live';
export type AppWorkItemStatus = 'backlog' | 'ready' | 'running' | 'review' | 'done' | 'blocked' | 'stale' | 'cancelled';

export interface AppStudioSession {
  id: number;
  project_id: number;
  company_session_id: number | null;
  name: string;
  app_slug: string;
  stack_profile_id: 'cf-fullstack-v1';
  created_at: string;
  updated_at: string;
}

export interface AppTeamSessionView {
  runtime_kind: 'app_studio';
  state: 'ready';
  company_session_id: number;
  company_status: 'idle' | 'running' | 'paused' | 'completed' | 'error';
  master_session_id: number;
  master_agent_run_id: number;
}

export interface AppTeamModelRef {
  provider: string;
  model: string;
}

export interface AppTeamRoleConfig {
  role: string;
  enabled: boolean;
  provider: string;
  model: string;
  tier: 'bootstrap' | 'navigate' | 'full';
  projectIds?: number[];
  skills?: string[];
  initialTools?: string[];
  availableToolNames?: string[];
  systemPromptOverride?: string;
  temperature?: number;
  reasoningEffort?: string;
  thinking?: boolean;
  thinkingBudgetTokens?: number;
  fallbackModels: AppTeamModelRef[];
}

export interface AppTeamConfigView {
  company_session_id: number;
  status: AppTeamSessionView['company_status'];
  operational_rules: string;
  roles: AppTeamRoleConfig[];
}

export interface AppPlanRevisionView {
  id: number;
  app_session_id: number;
  revision_number: number;
  status: AppPlanRevisionStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  plan: AppPlanV1 | null;
  fitness: AppFitnessReport | null;
}

export interface AppWorkItemView {
  id: string;
  app_session_id: number;
  plan_revision_id: number;
  slice_id: string | null;
  title: string;
  outcome: string;
  kind: string;
  owner_role: string;
  priority: number;
  status: AppWorkItemStatus;
  sort_order: number;
  depends_on: string[];
  source_ids: string[];
  acceptance: string[];
  evidence: Array<Record<string, unknown>>;
  file_scope: string[];
  blocked_reason: string | null;
  /** Runtime attempt data is enriched by newer servers; older servers omit it. */
  active_attempt?: AppWorkAttemptView | null;
  latest_attempt?: AppWorkAttemptView | null;
  attempts?: AppWorkAttemptView[];
  created_at: string;
  updated_at: string;
}

export interface AppWorkAttemptView {
  id: number;
  work_item_id?: string;
  attempt: number;
  role: string;
  company_agent_run_id: number | null;
  coder_session_id: number | null;
  status: 'claimed' | 'running' | 'waiting' | 'paused' | 'completed' | 'blocked' | 'error' | 'aborted' | 'interrupted' | 'cancelled';
  status_message: string | null;
  created_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
  updated_at: string;
}

export interface AppRecentEventView {
  id: number;
  /** `kind` is canonical; `event_type` keeps the client compatible with early previews. */
  kind?: string;
  event_type?: string;
  entity_type?: string;
  entity_id?: string;
  payload?: Record<string, unknown>;
  created_at: string;
}

export interface AppDecisionView {
  id: number;
  question: string;
  options: Array<{ label?: string; value?: string }>;
  blocked_work_item_ids: string[];
  status: 'open' | 'resolved';
  answer: string | null;
  requested_at: string;
  resolved_at: string | null;
}

export interface AppDeploymentView {
  id: number;
  status: 'publishing' | 'live' | 'failed';
  url: string | null;
  account: string | null;
  database_id: string | null;
  health_ok: number;
  created_at: string;
  updated_at: string;
}

export interface AppStudioSessionDetail {
  session: AppStudioSession;
  project: { id: number; name: string; root_path: string } | null;
  builder_port: number | null;
  stage: AppStage;
  plan_revision: AppPlanRevisionView | null;
  plan_history: Array<Pick<AppPlanRevisionView, 'id' | 'revision_number' | 'status' | 'created_by' | 'created_at' | 'approved_at'>>;
  work_items: AppWorkItemView[];
  decisions: AppDecisionView[];
  recent_events?: AppRecentEventView[];
  deployment: AppDeploymentView | null;
  evidence_current: boolean;
  team: AppTeamSessionView | null;
  master_session_id: number | null;
}

export type AppStudioListEntry = AppStudioSessionDetail;

function responseErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const body = payload as { error?: unknown; message?: unknown };
  if (typeof body.error === 'string' && body.error.trim()) return body.error;
  if (body.error && typeof body.error === 'object') {
    const nested = body.error as { message?: unknown };
    if (typeof nested.message === 'string' && nested.message.trim()) return nested.message;
  }
  if (typeof body.message === 'string' && body.message.trim()) return body.message;
  return fallback;
}

async function unwrap<T>(responsePromise: Response | Promise<Response>): Promise<T> {
  const response = await responsePromise;
  if (!response.ok) {
    let message = response.statusText || 'Request failed';
    try { message = responseErrorMessage(await response.json(), message); } catch { /* non-json */ }
    throw new Error(`${response.status}: ${message}`);
  }
  return response.json() as Promise<T>;
}

export async function listAppStudioSessions(): Promise<AppStudioListEntry[]> {
  return (await unwrap<{ apps: AppStudioListEntry[] }>(await fetch('/api/app-studio/apps'))).apps;
}

export function getAppStudioSession(id: number): Promise<AppStudioSessionDetail> {
  return unwrap(fetch(`/api/app-studio/apps/${id}`));
}

export function getAppTeamConfig(id: number): Promise<AppTeamConfigView> {
  return unwrap(fetch(`/api/app-studio/apps/${id}/team/config`));
}

export function updateAppTeamConfig(
  id: number,
  patch: { operational_rules?: string; roles?: AppTeamRoleConfig[] },
): Promise<AppTeamConfigView> {
  return unwrap(fetch(`/api/app-studio/apps/${id}/team/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }));
}

export async function deleteAppStudioSession(id: number): Promise<void> {
  await unwrap(await fetch(`/api/app-studio/apps/${id}`, { method: 'DELETE' }));
}

export type AppStudioAction = 'approve_plan_and_build' | 'dispatch_ready_work' | 'run_checks' | 'pause' | 'resume' | 'cancel';

export function runAppAction(id: number, action: AppStudioAction): Promise<AppStudioSessionDetail | { ok: true }> {
  return unwrap(fetch(`/api/app-studio/apps/${id}/actions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
  }));
}

export function answerAppDecision(id: number, decisionId: number, answer: string): Promise<{ decision: AppDecisionView }> {
  return unwrap(fetch(`/api/app-studio/apps/${id}/actions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'answer_decision', decision_id: decisionId, answer }),
  }));
}

export function updateAppPlan(id: number, plan: AppPlanV1, expectedRevisionNumber?: number): Promise<{ revision: AppPlanRevisionView }> {
  return unwrap(fetch(`/api/app-studio/apps/${id}/plan`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan, expected_revision_number: expectedRevisionNumber, created_by: 'user' }),
  }));
}

export interface AppStudioCreated {
  project: { id: number; name: string; root_path: string };
  app_session: AppStudioSession;
  master_session_id: number;
  company_session_id: number;
  team: AppTeamSessionView;
}

export async function createAppStudio(
  input: { name: string; provider: string; model: string; reasoning_effort?: string | null },
  handlers: { onPhase?: (phase: string, label: string) => void; onLog?: (stream: 'stdout' | 'stderr', chunk: string) => void } = {},
): Promise<AppStudioCreated> {
  const response = await fetch('/api/app-studio/apps', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  if (!response.ok || !response.body) throw new Error(`${response.status}: ${response.statusText}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      let event = 'message'; const lines: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) lines.push(line.slice(5).trimStart());
      }
      if (!lines.length) continue;
      const data = JSON.parse(lines.join('\n')) as Record<string, unknown>;
      if (event === 'phase') handlers.onPhase?.(String(data.phase), String(data.label));
      else if (event === 'log') handlers.onLog?.(data.stream as 'stdout' | 'stderr', String(data.chunk));
      else if (event === 'error') throw new Error(String(data.message));
      else if (event === 'done') return data as unknown as AppStudioCreated;
    }
  }
  throw new Error('App creation ended without a result.');
}
