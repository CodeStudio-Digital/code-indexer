/**
 * Local row types for the API-client tab — mirror the backend store columns
 * (migration 147) but kept in the dashboard so the renderer stays decoupled
 * from @mcp/store internals.
 */
export type ApiBodyKind = 'none' | 'json' | 'raw' | 'form';

export interface ApiCollection {
  id: number;
  project_id: number;
  name: string;
  description: string;
  spec_source: string | null;
  spec_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiEnvironment {
  id: number;
  project_id: number;
  name: string;
  base_url: string;
  variables_json: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface ApiRequest {
  id: number;
  collection_id: number;
  name: string;
  method: string;
  path_template: string;
  headers_json: string;
  query_json: string;
  body_json: string | null;
  body_kind: ApiBodyKind;
  verified: boolean;
  expected_status: number | null;
  assert_json: string | null;
  last_status: number | null;
  last_run_at: string | null;
  sort_order: number;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface SendResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  ms: number;
  url: string;
}

/** One recorded send (migration 148) — a row in the per-request Timeline. */
export interface ApiRequestHistory {
  id: number;
  request_id: number;
  status: number | null;
  ok: boolean;
  duration_ms: number | null;
  url: string | null;
  error: string | null;
  source: string;
  created_at: string;
}

/** An env variable as edited in the UI. `secret` masks the value in the list. */
export interface EnvVariable {
  key: string;
  value: string;
  secret: boolean;
}

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

export interface AssertionResult {
  requestId: number;
  name: string;
  method: string;
  expected: number | null;
  actual: number | null;
  ok: boolean;
  skipped?: boolean;
  reason?: string;
}

export interface RunReport {
  runId: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  status: 'passed' | 'failed' | 'error';
  results: AssertionResult[];
}

export interface ApiRegressionRun {
  id: number;
  collection_id: number;
  status: string;
  total: number;
  passed: number;
  failed: number;
  trigger: string;
  created_at: string;
  finished_at: string | null;
}

export interface ImportResult {
  collectionId: number;
  requestCount: number;
  created: number;
  updated: number;
  stale?: number;
  specChanged?: boolean;
}
