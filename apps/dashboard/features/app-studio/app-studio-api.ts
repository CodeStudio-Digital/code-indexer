/**
 * API client do App Studio (rotas /api/app-studio/...). Espelha a
 * convenção do design-system-api: wrappers tipados sobre fetch, Error em
 * non-2xx; criação via POST JSON que responde stream SSE
 * (start/phase/log/done/error — parse manual, EventSource não faz POST).
 */

export type AppStageId = 'discovery' | 'database' | 'design' | 'backend' | 'review' | 'launch';
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
  deploy: AppDeployView | null;
  features: Array<{ id: number; name: string; kind: string; summary: string | null; verified_in_preview: boolean }>;
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

export async function deleteAppStudioSession(sessionId: number): Promise<void> {
  await unwrap(await fetch(`/api/app-studio/sessions/${sessionId}`, { method: 'DELETE' }));
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
