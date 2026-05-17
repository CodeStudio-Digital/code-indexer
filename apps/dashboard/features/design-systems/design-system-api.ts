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

export interface DesignSystemSession {
  id: number;
  company_session_id: number;
  name: string;
  package_name: string;
  stack: DsStack;
  source_zip_hash: string | null;
  source_zip_path: string | null;
  next_bump_hint: DsBumpHint;
  mcp_server_config_id: string | null;
  created_at: string;
}

export interface DesignSystemSessionListEntry extends DesignSystemSession {
  company_session_status: string;
  is_running: boolean;
  latest_published_semver: string | null;
  latest_published_at: string | null;
}

export interface DesignSystemVersion {
  id: number;
  ds_session_id: number;
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
  id: number;
  version_id: number;
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

export interface CreateSessionInput {
  name: string;
  package_name: string;
  stack: DsStack;
  master_provider: string;
  master_model: string;
  zip: File;
}

export async function createDesignSystemSession(input: CreateSessionInput): Promise<{
  design_system_session: DesignSystemSession;
  company_session_id: number;
}> {
  const form = new FormData();
  form.set('name', input.name);
  form.set('package_name', input.package_name);
  form.set('stack', input.stack);
  form.set('master_provider', input.master_provider);
  form.set('master_model', input.master_model);
  form.set('zip', input.zip);
  const r = await fetch('/api/design-system/sessions', { method: 'POST', body: form });
  return unwrap(r);
}

export async function listDesignSystemSessions(): Promise<DesignSystemSessionListEntry[]> {
  const r = await fetch('/api/design-system/sessions');
  const body = await unwrap<{ sessions: DesignSystemSessionListEntry[] }>(r);
  return body.sessions;
}

export async function getDesignSystemSession(id: number): Promise<{
  session: DesignSystemSession;
  versions: DesignSystemVersion[];
  latest_published: DesignSystemVersion | null;
  is_running: boolean;
  company_session_status: string;
}> {
  const r = await fetch(`/api/design-system/sessions/${id}`);
  return unwrap(r);
}

export async function startDesignSystemRound(
  id: number,
  body: { extra_instructions?: string; max_turns?: number } = {},
): Promise<void> {
  // The route returns an SSE stream — we don't read it here; the client
  // separately opens an EventSource against /stream when it wants live
  // events. We just need the round to have started, so a HEAD-style
  // ping is enough: read once and close.
  const r = await fetch(`/api/design-system/sessions/${id}/start-round`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let msg: string;
    try {
      const errBody = await r.json();
      msg = (errBody as { error?: string }).error ?? r.statusText;
    } catch {
      msg = r.statusText;
    }
    throw new Error(`${r.status}: ${msg}`);
  }
  // Drain in the background — the master is already running server-side.
  void r.body?.cancel();
}

export async function abortDesignSystemRound(id: number): Promise<{ ok: boolean; was_running: boolean }> {
  return unwrap(await fetch(`/api/design-system/sessions/${id}/abort`, { method: 'POST' }));
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
export async function reExtractDesignSystem(id: number, zip?: File): Promise<ReExtractResult> {
  const init: RequestInit = { method: 'POST' };
  if (zip) {
    const form = new FormData();
    form.set('zip', zip);
    init.body = form;
  }
  const r = await fetch(`/api/design-system/sessions/${id}/re-extract`, init);
  return unwrap(r);
}

export async function setNextBumpHint(id: number, hint: DsBumpHint): Promise<DesignSystemSession> {
  const r = await fetch(`/api/design-system/sessions/${id}/next-bump-hint`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hint }),
  });
  const body = await unwrap<{ session: DesignSystemSession }>(r);
  return body.session;
}

export async function deleteDesignSystemSession(id: number): Promise<void> {
  const r = await fetch(`/api/design-system/sessions/${id}`, { method: 'DELETE' });
  await unwrap(r);
}

export async function listVersionComponents(
  sessionId: number,
  semver: string,
): Promise<DesignSystemComponent[]> {
  const r = await fetch(
    `/api/design-system/sessions/${sessionId}/versions/${encodeURIComponent(semver)}/components`,
  );
  const body = await unwrap<{ components: DesignSystemComponent[] }>(r);
  return body.components;
}

export async function fetchVersionDocs(sessionId: number, semver: string): Promise<string> {
  const r = await fetch(
    `/api/design-system/sessions/${sessionId}/versions/${encodeURIComponent(semver)}/docs`,
  );
  if (!r.ok) throw new Error(`${r.status}: ${r.statusText}`);
  return r.text();
}

export function storybookSrc(sessionId: number, semver: string): string {
  return `/api/design-system/sessions/${sessionId}/versions/${encodeURIComponent(semver)}/storybook/index.html`;
}

export async function installDesignSystemMcp(
  sessionId: number,
  semver: string,
): Promise<{ ok: boolean; mcp_server_config_id: string; server_js_path: string }> {
  const r = await fetch(
    `/api/design-system/sessions/${sessionId}/versions/${encodeURIComponent(semver)}/install-mcp`,
    { method: 'POST' },
  );
  return unwrap(r);
}
