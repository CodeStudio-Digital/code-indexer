/**
 * Row + input types for the API client store (migration 147). Field names
 * mirror the DB columns (snake_case) so hydration is a near-cast — only the
 * integer-boolean columns (`verified`, `is_default`) are coerced.
 */
// 'form' is a legacy alias (pre-mig-156) read as 'urlencoded' by the backend.
export type ApiBodyKind =
  | 'none' | 'json' | 'raw' | 'form-data' | 'urlencoded' | 'graphql' | 'binary' | 'form';
export type ApiBodyRawLang = 'text' | 'json' | 'xml' | 'html' | 'javascript';
export type ApiAuthType = 'none' | 'bearer' | 'basic' | 'apikey' | 'oauth2';
export type ApiRequestSource = 'manual' | 'openapi' | 'agent';
export type ApiRunStatus = 'running' | 'passed' | 'failed' | 'error';
export type ApiRunTrigger = 'manual' | 'cli' | 'agent';

export interface ApiCollection {
  id: number;
  project_id: number;
  name: string;
  description: string;
  spec_source: string | null;
  spec_hash: string | null;
  /** Explicit ordered folder names (JSON string[]) — lets empty folders persist. */
  folders_json: string;
  created_at: string;
  updated_at: string;
}

export interface ApiEnvironment {
  id: number;
  project_id: number;
  name: string;
  base_url: string;
  /** JSON: `{ [key]: { value: string, secret?: boolean } }`. */
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
  /** raw-body sub-language hint (when body_kind === 'raw'). */
  body_raw_lang: ApiBodyRawLang | null;
  /** KvRow[] JSON for form-data (rows may carry a file `src`). */
  body_form_json: string;
  /** KvRow[] JSON for x-www-form-urlencoded. */
  body_urlencoded_json: string;
  /** `{ query: string, variables: string }` JSON for GraphQL. */
  body_graphql_json: string | null;
  /** Absolute host path streamed for body_kind === 'binary'. */
  body_binary_path: string | null;
  /** Pre-request JS (Postman `pm.*`). */
  pre_request_script: string | null;
  /** Test/post-response JS (Postman `pm.*`). */
  test_script: string | null;
  auth_type: ApiAuthType | null;
  /** Per-type auth config JSON; shape depends on auth_type. */
  auth_json: string | null;
  /** Single-level group label (OpenAPI tag / first path segment). '' = top level. */
  folder: string | null;
  verified: boolean;
  expected_status: number | null;
  assert_json: string | null;
  last_status: number | null;
  last_run_at: string | null;
  sort_order: number;
  source: ApiRequestSource;
  created_at: string;
  updated_at: string;
}

export interface ApiRegressionRun {
  id: number;
  collection_id: number;
  env_id: number | null;
  status: ApiRunStatus;
  total: number;
  passed: number;
  failed: number;
  results_json: string;
  trigger: ApiRunTrigger;
  created_at: string;
  finished_at: string | null;
}

/** One recorded send of a request (migration 148) — backs the Timeline tab. */
export interface ApiRequestHistory {
  id: number;
  request_id: number;
  status: number | null;
  ok: boolean;
  duration_ms: number | null;
  url: string | null;
  error: string | null;
  source: ApiRequestSource;
  created_at: string;
}

export interface InsertRequestHistoryInput {
  request_id: number;
  status?: number | null;
  ok: boolean;
  duration_ms?: number | null;
  url?: string | null;
  error?: string | null;
  source?: ApiRequestSource;
}

export interface CreateCollectionInput {
  project_id: number;
  name: string;
  description?: string;
  spec_source?: string | null;
  spec_hash?: string | null;
}

export interface CreateRequestInput {
  collection_id: number;
  name: string;
  method?: string;
  path_template?: string;
  headers_json?: string;
  query_json?: string;
  body_json?: string | null;
  body_kind?: ApiBodyKind;
  body_raw_lang?: ApiBodyRawLang | null;
  body_form_json?: string;
  body_urlencoded_json?: string;
  body_graphql_json?: string | null;
  body_binary_path?: string | null;
  pre_request_script?: string | null;
  test_script?: string | null;
  auth_type?: ApiAuthType | null;
  auth_json?: string | null;
  folder?: string | null;
  sort_order?: number;
  source?: ApiRequestSource;
}

export interface UpsertEnvironmentInput {
  id?: number;
  project_id: number;
  name: string;
  base_url?: string;
  variables_json?: string;
  is_default?: boolean;
}

/** Partial patch for a request — used by manual edits AND the agent fix loop. */
export type RequestPatch = Partial<
  Pick<
    ApiRequest,
    | 'name' | 'method' | 'path_template' | 'headers_json' | 'query_json'
    | 'body_json' | 'body_kind' | 'body_raw_lang' | 'body_form_json'
    | 'body_urlencoded_json' | 'body_graphql_json' | 'body_binary_path'
    | 'pre_request_script' | 'test_script' | 'auth_type' | 'auth_json' | 'folder'
    | 'sort_order' | 'last_status' | 'last_run_at'
  >
>;
