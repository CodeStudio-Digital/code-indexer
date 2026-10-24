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
import { redactSecrets, REDACTION_PLACEHOLDER } from '../ai/redact.js';

interface EnvBody {
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

interface EnvApplyAction {
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
 *  the apply path can hand them straight to `createRequest`).
 *  Deliberately EXCLUDED from sync (local/derived state, never round-tripped):
 *  `param_docs_json`, `verified`, `expected_status`, `assert_json`, `last_status`,
 *  `last_run_at`, `source`, and the host-local `body_binary_path`. */
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

/** Auth-config fields that carry a credential — blanked on push, restored on apply. */
const AUTH_SECRET_FIELDS = ['token', 'password', 'value', 'clientSecret', 'accessToken', 'refreshToken', 'apiKey'] as const;

/** Blank the credential field of a request's auth config (keep type + non-secret bits). */
function redactAuthJson(authJson: string | null | undefined): string | null {
  if (!authJson) return authJson ?? null;
  try {
    const a = JSON.parse(authJson) as Record<string, unknown> & { type?: string };
    for (const f of AUTH_SECRET_FIELDS) {
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

// ─── Non-destructive, secret-preserving apply ──────────────────────────────────
//
// Applying a pulled collection used to delete every local request and recreate it
// from the (redacted) body — which silently wiped real local credentials (auth
// tokens, secret headers) and any local-only request. The helpers below let the
// apply MATCH requests by a stable key and MERGE: blanked credential values keep
// their real local value, and a body that differs only by redaction is left as-is.

/** Stable identity for matching a synced request against a local one: method +
 *  path + name. Works on both `ApiRequest` and the synced `RequestBody`. */
export function requestMatchKey(r: { name: string; method: string; path_template: string; folder?: string | null }): string {
  return `${(r.method || 'GET').toUpperCase()}${r.path_template}${r.folder ?? ''}${r.name}`;
}

/** Restore blanked credential-named values in an incoming KvRow JSON from the
 *  matching local row (by key). Non-credential rows and structure are untouched. */
function mergeKvSecrets(incomingJson: string, localJson: string): string {
  try {
    const inc = JSON.parse(incomingJson) as KvRow[];
    if (!Array.isArray(inc)) return incomingJson;
    const localByKey = new Map<string, string>();
    try {
      const loc = JSON.parse(localJson) as KvRow[];
      if (Array.isArray(loc)) for (const row of loc) {
        const k = String(row?.key ?? '');
        if (k && !localByKey.has(k)) localByKey.set(k, String(row?.value ?? ''));
      }
    } catch { /* local malformed → nothing to restore */ }
    return JSON.stringify(inc.map((row) => {
      if (row && CREDENTIAL_KEY.test(String(row.key ?? '')) && !row.value) {
        const lv = localByKey.get(String(row.key));
        if (lv) return { ...row, value: lv };
      }
      return row;
    }));
  } catch {
    return incomingJson;
  }
}

/** Restore blanked auth credential fields from the local auth config. */
function mergeAuthSecrets(incomingJson: string | null, localJson: string | null): string | null {
  if (!incomingJson) return incomingJson ?? null;
  try {
    const inc = JSON.parse(incomingJson) as Record<string, unknown>;
    const loc = localJson ? (JSON.parse(localJson) as Record<string, unknown>) : {};
    for (const f of AUTH_SECRET_FIELDS) {
      // Only restore a field the incoming auth actually HAS and that was blanked
      // (redactAuthJson keeps the key, sets ''). `f in inc` avoids adding a stray
      // field from a different local auth type; the explicit empty/null check
      // avoids treating a falsy non-string (0/false) as "blank".
      if (f in inc && (inc[f] === '' || inc[f] == null) && typeof loc[f] === 'string' && loc[f]) inc[f] = loc[f];
    }
    return JSON.stringify(inc);
  } catch {
    return incomingJson;
  }
}

/** A text body is carried redacted. Resolve the apply value without ever writing
 *  the redaction placeholder over a real local secret:
 *   - remote unchanged (incoming === our own redaction of local) → keep local;
 *   - genuine remote edit that still carries a `«redacted»` mask → keep local
 *     (we forgo the remote structural edit; the safe trade-off, since taking it
 *     would clobber the local secret with the placeholder);
 *   - genuine remote edit with no mask → honor it. */
function mergeRedactedText(incoming: string | null, local: string | null): string | null {
  if (incoming == null || local == null) return incoming;
  if (redactSecrets(local) === incoming) return local;
  if (incoming.includes(REDACTION_PLACEHOLDER)) return local;
  return incoming;
}

/** Merge a pulled (redacted) request body onto the matching LOCAL request so the
 *  apply is non-destructive and never clobbers a real local secret with a mask.
 *  Pure; returns a request patch suitable for `patchRequest`. */
export function mergeRequestForApply(incoming: RequestBody, local: ApiRequest): Partial<ApiRequest> {
  return {
    name: incoming.name,
    method: incoming.method,
    path_template: incoming.path_template,
    headers_json: mergeKvSecrets(incoming.headers_json, local.headers_json),
    query_json: mergeKvSecrets(incoming.query_json, local.query_json),
    body_json: mergeRedactedText(incoming.body_json, local.body_json),
    body_kind: incoming.body_kind as ApiRequest['body_kind'],
    body_raw_lang: incoming.body_raw_lang as ApiRequest['body_raw_lang'],
    body_form_json: mergeKvSecrets(incoming.body_form_json, local.body_form_json),
    body_urlencoded_json: mergeKvSecrets(incoming.body_urlencoded_json, local.body_urlencoded_json),
    body_graphql_json: mergeRedactedText(incoming.body_graphql_json, local.body_graphql_json),
    body_binary_path: local.body_binary_path, // host-local; never carried by sync — keep local
    pre_request_script: incoming.pre_request_script,
    test_script: incoming.test_script,
    auth_type: incoming.auth_type as ApiRequest['auth_type'],
    auth_json: mergeAuthSecrets(incoming.auth_json, local.auth_json),
    description: incoming.description,
    folder: incoming.folder,
    sort_order: incoming.sort_order,
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

interface CollectionApplyAction {
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
