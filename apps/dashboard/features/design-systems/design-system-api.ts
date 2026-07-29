/**
 * API client for the Design System Creator routes (mounted at
 * /api/design-system/...).
 *
 * Mirrors the convention used by `chrome-service-api.ts` /
 * `qa-api.ts`: typed wrappers around `fetch`, throwing `Error` on
 * non-2xx so callers can surface the message verbatim.
 */
export type DsStack = 'react-ts' | 'vue-ts' | 'angular';
export type DsBumpHint = 'patch' | 'minor' | 'major';
export type DsBumpKind = 'initial' | 'patch' | 'minor' | 'major';
export type DsVersionStatus = 'draft' | 'building' | 'published' | 'failed' | 'skipped';
export type DsComponentKind = 'atom' | 'page-template';
/** 'studio' = single-session workspace (atual); 'company' = pipeline legado (read-only). */
export type DsSessionKind = 'company' | 'studio';
/** 'fidelity' = tema anexado é fonte da verdade; 'creative' = inspiração. */
export type DsSessionMode = 'fidelity' | 'creative';

export interface DesignSystemSession {
  id: string;
  company_session_id: string | null;
  project_id: number | null;
  kind: DsSessionKind;
  name: string;
  package_name: string;
  stack: DsStack;
  source_zip_hash: string | null;
  source_zip_path: string | null;
  next_bump_hint: DsBumpHint;
  mcp_server_config_id: string | null;
  mode: DsSessionMode;
  created_at: string;
}

// ── Design pipeline (máquina de etapas, mig 190) ────────────────────

export type DsStageId =
  | 'analysis' | 'tokens' | 'primitives' | 'composites' | 'templates' | 'docs' | 'publish';
export type DsStageStatus = 'pending' | 'active' | 'review' | 'approved' | 'skipped';
export type DsStageAction = 'start' | 'approve' | 'reopen' | 'skip';
export type DsRoadmapTier = 'primitive' | 'composite' | 'template';

export interface DsPipelineStage {
  id: DsStageId;
  status: DsStageStatus;
  summary: string | null;
  gate: { ok: boolean; issues: string[] } | null;
  feedback: string | null;
  submitted_at: string | null;
  approved_at: string | null;
}

export interface DsRoadmapEntry {
  name: string;
  tier: DsRoadmapTier;
  source: 'catalog' | 'digest';
  source_refs?: string[];
  recorded: boolean;
}

export interface DsThemeDigestSummary {
  sha256: string;
  generated_at: string;
  files: number;
  colors: number;
  components: number;
}

export interface DsPipelineView {
  stages: DsPipelineStage[];
  current_stage: DsStageId | null;
  roadmap: DsRoadmapEntry[];
  theme_digest: DsThemeDigestSummary | null;
}

export interface DsProjectSummary {
  id: number;
  name: string;
  root_path: string;
}

export interface DesignSystemSessionListEntry extends DesignSystemSession {
  company_session_status: string;
  is_running: boolean;
  latest_published_semver: string | null;
  latest_published_at: string | null;
  builder_port: number | null;
  project: DsProjectSummary | null;
}

export interface DesignSystemVersion {
  id: string;
  ds_session_id: string;
  semver: string;
  bump_kind: DsBumpKind;
  is_auto_bump: boolean;
  status: DsVersionStatus;
  source_hash: string | null;
  tarball_path: string | null;
  manifest_json: string | null;
  mcp_manifest_json: string | null;
  docs_md: string | null;
  storybook_path: string | null;
  error: string | null;
  created_at: string;
  published_at: string | null;
}

export interface DesignSystemComponent {
  id: string;
  version_id: string;
  name: string;
  kind: DsComponentKind;
  props_schema_json: string | null;
  example_code: string | null;
  created_at: string;
}

async function unwrap<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg: string;
    try {
      const body = await r.json();
      msg = (body as { error?: string }).error ?? r.statusText;
    } catch {
      msg = r.statusText;
    }
    throw new Error(`${r.status}: ${msg}`);
  }
  return (await r.json()) as T;
}

export async function listDesignSystemSessions(): Promise<DesignSystemSessionListEntry[]> {
  const r = await fetch('/api/design-system/sessions');
  const body = await unwrap<{ sessions: DesignSystemSessionListEntry[] }>(r);
  return body.sessions;
}

export interface DesignSystemSessionDetail {
  session: DesignSystemSession;
  versions: DesignSystemVersion[];
  latest_published: DesignSystemVersion | null;
  is_running: boolean;
  company_session_status: string;
  builder_port: number | null;
  project: DsProjectSummary | null;
  pipeline: DsPipelineView | null;
}

export async function getDesignSystemSession(id: string): Promise<DesignSystemSessionDetail> {
  const r = await fetch(`/api/design-system/sessions/${id}`);
  return unwrap(r);
}

export interface ReExtractResult {
  ok: boolean;
  extracted: { files: number; bytes: number; skipped: Array<{ entry: string; reason: string }> };
  zip_replaced: boolean;
}

/**
 * Re-extract the theme zip into the virtual project's `design_system/` folder.
 * Pass a fresh `zip` File to replace the persisted one; omit it to re-extract
 * the existing zip (useful when the on-disk folder was tampered with).
 */
export async function reExtractDesignSystem(id: string, zip?: File): Promise<ReExtractResult> {
  const init: RequestInit = { method: 'POST' };
  if (zip) {
    const form = new FormData();
    form.set('zip', zip);
    init.body = form;
  }
  const r = await fetch(`/api/design-system/sessions/${id}/re-extract`, init);
  return unwrap(r);
}

export async function setNextBumpHint(id: string, hint: DsBumpHint): Promise<DesignSystemSession> {
  const r = await fetch(`/api/design-system/sessions/${id}/next-bump-hint`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hint }),
  });
  const body = await unwrap<{ session: DesignSystemSession }>(r);
  return body.session;
}

export async function patchPipelineStage(
  id: string,
  stageId: DsStageId,
  action: DsStageAction,
  feedback?: string,
): Promise<DsPipelineView['stages']> {
  const r = await fetch(`/api/design-system/sessions/${id}/pipeline/stage`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage_id: stageId, action, feedback }),
  });
  const body = await unwrap<{ pipeline: { stages: DsPipelineView['stages'] } }>(r);
  return body.pipeline.stages;
}

/** Backfill do pipeline em sessões studio pré-feature. */
export async function initPipeline(id: string): Promise<void> {
  const r = await fetch(`/api/design-system/sessions/${id}/pipeline/init`, { method: 'POST' });
  await unwrap(r);
}

export async function analyzeImportDs(id: string): Promise<DsThemeDigestSummary> {
  const r = await fetch(`/api/design-system/sessions/${id}/analyze-import`, { method: 'POST' });
  const body = await unwrap<{ digest: DsThemeDigestSummary }>(r);
  return body.digest;
}

export async function deleteDesignSystemSession(id: string): Promise<void> {
  const r = await fetch(`/api/design-system/sessions/${id}`, { method: 'DELETE' });
  await unwrap(r);
}

export async function listVersionComponents(
  sessionId: string,
  semver: string,
): Promise<DesignSystemComponent[]> {
  const r = await fetch(
    `/api/design-system/sessions/${sessionId}/versions/${encodeURIComponent(semver)}/components`,
  );
  const body = await unwrap<{ components: DesignSystemComponent[] }>(r);
  return body.components;
}

export async function fetchVersionDocs(sessionId: string, semver: string): Promise<string> {
  const r = await fetch(
    `/api/design-system/sessions/${sessionId}/versions/${encodeURIComponent(semver)}/docs`,
  );
  if (!r.ok) throw new Error(`${r.status}: ${r.statusText}`);
  return r.text();
}

export function storybookSrc(sessionId: string, semver: string): string {
  return `/api/design-system/sessions/${sessionId}/versions/${encodeURIComponent(semver)}/storybook/index.html`;
}

export async function installDesignSystemMcp(
  sessionId: string,
  semver: string,
): Promise<{ ok: boolean; mcp_server_config_id: string; server_js_path: string }> {
  const r = await fetch(
    `/api/design-system/sessions/${sessionId}/versions/${encodeURIComponent(semver)}/install-mcp`,
    { method: 'POST' },
  );
  return unwrap(r);
}
