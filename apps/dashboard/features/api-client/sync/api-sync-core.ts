/**
 * Pure client sync core for the API-client (no React, no I/O, no localStorage) so
 * the tricky bits — secret-safe serialization and the push/apply plans — are unit
 * testable. The hook (use-api-sync) owns persistence + the HTTP calls.
 *
 * Scope key: a per-project `workspaceId` prefixes every `clientDocId`
 * (`<workspaceId>:<uuid>`). Sync is account-wide, so the workspace prefix is what
 * scopes a project's docs (and lets a second machine JOIN the same workspace by
 * sharing the id). Secrets never leave: env GET already masks secret values with
 * `••••`, and the server's `mergeSecrets` restores/empties them on apply — so the
 * synced body carries only the mask, never a real secret.
 */
import type { SyncPullItem, SyncPushItem } from '@mcp/api-bus';
import type { ApiCollection, ApiEnvironment, ApiRequest, KvRow } from '../types.js';
import { redactSecrets } from '../ai/redact.js';

export interface EnvBody {
  name: string;
  baseUrl: string;
  isDefault: boolean;
  variables: Record<string, { value: string; secret: boolean }>;
}

/** Local env row → the synced body. Secret values arrive already masked from the
 *  list endpoint, so they're carried as the mask (never the real secret). */
export function envToBody(env: ApiEnvironment): EnvBody {
  const variables: EnvBody['variables'] = {};
  try {
    const raw = JSON.parse(env.variables_json || '{}') as Record<string, { value?: string; secret?: boolean } | string>;
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v === 'object') variables[k] = { value: v.value ?? '', secret: !!v.secret };
      else variables[k] = { value: String(v ?? ''), secret: false };
    }
  } catch {
    /* malformed → empty var map */
  }
  return { name: env.name, baseUrl: env.base_url, isDefault: env.is_default, variables };
}

/** Synced body → the upsert payload. A masked secret value (`••••`) is preserved
 *  by the server's mergeSecrets (kept if the var exists locally, emptied if new),
 *  so applying never clobbers a real local secret with the mask. */
export function bodyToUpsert(body: EnvBody, localId?: number): {
  id?: number;
  name: string;
  base_url: string;
  is_default: boolean;
  variables: Record<string, { value: string; secret: boolean }>;
} {
  const variables: Record<string, { value: string; secret: boolean }> = {};
  for (const [k, v] of Object.entries(body.variables ?? {})) variables[k] = { value: v.value, secret: v.secret };
  return { id: localId, name: body.name, base_url: body.baseUrl, is_default: body.isDefault, variables };
}

/** Build the push batch for every local environment. */
export function planEnvPush(
  envs: ApiEnvironment[],
  clientDocIdFor: (envId: number) => string,
  knownVersion: (clientDocId: string) => number,
  nowMs: number,
): SyncPushItem[] {
  return envs.map((e) => {
    const clientDocId = clientDocIdFor(e.id);
    return { kind: 'environment', clientDocId, baseVersion: knownVersion(clientDocId), updatedAtMs: nowMs, body: envToBody(e) };
  });
}

export interface EnvApplyAction {
  clientDocId: string;
  version: number;
  deleted: boolean;
  body: EnvBody | null;
}

/** From a pull response, the env docs for THIS workspace that are newer than what
 *  we already have locally (so re-pulling our own just-pushed docs is a no-op). */
export function planEnvApply(
  pulled: SyncPullItem[],
  workspaceId: string,
  knownVersion: (clientDocId: string) => number,
): EnvApplyAction[] {
  const prefix = `${workspaceId}:`;
  return pulled
    .filter((d) => d.kind === 'environment' && d.clientDocId.startsWith(prefix) && d.version > knownVersion(d.clientDocId))
    .map((d) => ({ clientDocId: d.clientDocId, version: d.version, deleted: d.deleted, body: d.deleted ? null : (d.body as EnvBody) }));
}

// ─── Collections (structure-only; secrets stripped CLIENT-SIDE before push) ────
//
// A collection's REQUESTS hold inline credentials (auth tokens, secret headers/
// query params, literal tokens in bodies), and — unlike environments — the server
// does NOT mask them. So redaction happens HERE, before anything leaves the device:
// credential values are blanked and the (host-local) binary upload path is dropped.
// The synced collection doc embeds its redacted requests as a tree.

/** Request fields carried in a synced collection (mirror ApiRequest column names so
 *  the apply path can hand them straight to `createRequest`). */
export interface RequestBody {
  name: string;
  method: string;
  path_template: string;
  headers_json: string;
  query_json: string;
  body_json: string | null;
  body_kind: string;
  body_raw_lang: string | null;
  body_form_json: string;
  body_urlencoded_json: string;
  body_graphql_json: string | null;
  body_binary_path: null;
  pre_request_script: string | null;
  test_script: string | null;
  auth_type: string | null;
  auth_json: string | null;
  description: string | null;
  folder: string | null;
  sort_order: number;
}

export interface CollectionBody {
  name: string;
  description: string;
  folders_json: string;
  requests: RequestBody[];
}

/** Header/query/form keys whose VALUE is a credential and must be blanked. */
const CREDENTIAL_KEY =
  /^(?:authorization|cookie|x-api-key|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd|key|sig|signature|x-auth-token|x-amz-security-token)$/i;

/** Blank credential-named values in a KvRow[] JSON string (keys/structure kept). */
function redactKvRows(json: string | null | undefined): string {
  if (!json) return json ?? '';
  try {
    const rows = JSON.parse(json) as KvRow[];
    if (!Array.isArray(rows)) return json;
    return JSON.stringify(rows.map((r) => (r && CREDENTIAL_KEY.test(String(r.key ?? '')) ? { ...r, value: '' } : r)));
  } catch {
    return json;
  }
}

/** Blank the credential field of a request's auth config (keep type + non-secret bits). */
function redactAuthJson(authJson: string | null | undefined): string | null {
  if (!authJson) return authJson ?? null;
  try {
    const a = JSON.parse(authJson) as Record<string, unknown> & { type?: string };
    for (const f of ['token', 'password', 'value', 'clientSecret', 'accessToken', 'refreshToken', 'apiKey'] as const) {
      if (typeof a[f] === 'string') a[f] = '';
    }
    return JSON.stringify(a);
  } catch {
    return authJson;
  }
}

/** Local request row → redacted, structure-only sync shape. NO real secret leaves. */
export function redactRequestForSync(req: ApiRequest): RequestBody {
  const isText = req.body_kind === 'json' || req.body_kind === 'raw' || req.body_kind === 'graphql';
  return {
    name: req.name,
    method: req.method,
    path_template: req.path_template,
    headers_json: redactKvRows(req.headers_json),
    query_json: redactKvRows(req.query_json),
    body_json: isText ? redactSecrets(req.body_json) : req.body_json,
    body_kind: req.body_kind,
    body_raw_lang: req.body_raw_lang,
    body_form_json: redactKvRows(req.body_form_json),
    body_urlencoded_json: redactKvRows(req.body_urlencoded_json),
    body_graphql_json: req.body_graphql_json ? redactSecrets(req.body_graphql_json) : req.body_graphql_json,
    body_binary_path: null, // host-local path — never syncable
    pre_request_script: req.pre_request_script,
    test_script: req.test_script,
    auth_type: req.auth_type,
    auth_json: redactAuthJson(req.auth_json),
    description: req.description ?? null,
    folder: req.folder,
    sort_order: req.sort_order,
  };
}

export function collectionToBody(collection: ApiCollection, requests: ApiRequest[]): CollectionBody {
  return {
    name: collection.name,
    description: collection.description,
    folders_json: collection.folders_json,
    requests: requests.map(redactRequestForSync),
  };
}

/** Build the push batch for every local collection (with its redacted requests). */
export function planCollectionPush(
  items: { collection: ApiCollection; requests: ApiRequest[] }[],
  clientDocIdFor: (collectionId: number) => string,
  knownVersion: (clientDocId: string) => number,
  nowMs: number,
): SyncPushItem[] {
  return items.map(({ collection, requests }) => {
    const clientDocId = clientDocIdFor(collection.id);
    return {
      kind: 'collection',
      clientDocId,
      baseVersion: knownVersion(clientDocId),
      updatedAtMs: nowMs,
      body: collectionToBody(collection, requests),
    };
  });
}

export interface CollectionApplyAction {
  clientDocId: string;
  version: number;
  deleted: boolean;
  body: CollectionBody | null;
}

/** From a pull, this workspace's collection docs newer than what we have locally. */
export function planCollectionApply(
  pulled: SyncPullItem[],
  workspaceId: string,
  knownVersion: (clientDocId: string) => number,
): CollectionApplyAction[] {
  const prefix = `${workspaceId}:`;
  return pulled
    .filter((d) => d.kind === 'collection' && d.clientDocId.startsWith(prefix) && d.version > knownVersion(d.clientDocId))
    .map((d) => ({ clientDocId: d.clientDocId, version: d.version, deleted: d.deleted, body: d.deleted ? null : (d.body as CollectionBody) }));
}
