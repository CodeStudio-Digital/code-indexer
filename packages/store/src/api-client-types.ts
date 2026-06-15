/**
 * Row + input types for the API client store (migration 147). Field names
 * mirror the DB columns (snake_case) so hydration is a near-cast — only the
 * integer-boolean columns (`verified`, `is_default`) are coerced.
 */
export type ApiBodyKind = 'none' | 'json' | 'raw' | 'form';
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
    | 'body_json' | 'body_kind' | 'sort_order' | 'last_status' | 'last_run_at'
  >
>;
