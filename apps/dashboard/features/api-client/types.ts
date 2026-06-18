/**
 * Local row types for the API-client tab — mirror the backend store columns
 * (migration 147) but kept in the dashboard so the renderer stays decoupled
 * from @mcp/store internals.
 */
// 'form' is a legacy alias (pre-mig-156) treated as 'urlencoded' by the backend.
export type ApiBodyKind =
  | 'none' | 'json' | 'raw' | 'form-data' | 'urlencoded' | 'graphql' | 'binary' | 'form';
export type ApiBodyRawLang = 'text' | 'json' | 'xml' | 'html' | 'javascript';
export type ApiAuthType = 'none' | 'bearer' | 'basic' | 'apikey' | 'oauth2';

/** One header/query/form row — mirrors backend KvRow (request-builder.ts). */
export interface KvRow {
  key: string;
  value: string;
  enabled: boolean;
  description?: string;
  /** form-data only: absolute path when this row is a file part. */
  src?: string;
}

export interface ApiCollection {
  id: number;
  project_id: number;
  name: string;
  description: string;
  spec_source: string | null;
  spec_hash: string | null;
  folders_json: string;
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
  body_raw_lang: ApiBodyRawLang | null;
  body_form_json: string;
  body_urlencoded_json: string;
  body_graphql_json: string | null;
  body_binary_path: string | null;
  pre_request_script: string | null;
  test_script: string | null;
  auth_type: ApiAuthType | null;
  auth_json: string | null;
  folder: string | null;
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

/** Outcome of one `pm.test(...)` call (pre + test phases flattened). */
export interface ScriptTestResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface SendResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  ms: number;
  url: string;
  tests?: ScriptTestResult[];
  consoleLogs?: string[];
  scriptError?: string;
  cookies?: { name: string; value: string }[];
  size?: number;
  truncated?: boolean;
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
  tests?: ScriptTestResult[];
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
