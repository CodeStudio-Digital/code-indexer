/**
 * importOpenApiInto — discover + parse an OpenAPI/Swagger spec and reconcile
 * its operations into a collection. Shared by the HTTP import route and the
 * `api_import_openapi` agent tool so there's one idempotent implementation.
 *
 * Idempotent: a collection previously imported from the same source path is
 * reused; verified requests are NEVER overwritten (their fix/verification
 * survives re-import); new operations are inserted, unverified ones refreshed.
 */
import { basename } from 'node:path';
import type { ApiClientStore } from '@mcp/store/api-client-store.js';
import { parseOpenApi, type ParsedOperation } from './openapi-walker.js';
import { probeOpenApiOnHost } from './openapi-probe.js';

export function reconcileOperations(
  store: ApiClientStore,
  collectionId: number,
  ops: ParsedOperation[],
): { created: number; updated: number; stale: number } {
  const existing = store.listRequests(collectionId);
  const byKey = new Map(existing.map((r) => [`${r.method} ${r.path_template}`, r]));
  const matched = new Set<string>();
  let created = 0, updated = 0;
  ops.forEach((op, i) => {
    const key = `${op.method} ${op.path}`;
    matched.add(key);
    const fields = {
      method: op.method,
      path_template: op.path,
      headers_json: JSON.stringify(op.headers),
      query_json: JSON.stringify(op.query),
      body_json: op.bodyExample != null ? JSON.stringify(op.bodyExample, null, 2) : null,
      body_kind: (op.bodyExample != null ? 'json' : 'none') as 'json' | 'none',
      folder: op.folder || null,
    };
    const prev = byKey.get(key);
    if (prev) {
      if (!prev.verified) { store.updateRequest(prev.id, fields); updated++; }
    } else {
      store.createRequest({ collection_id: collectionId, name: op.name, sort_order: i, source: 'openapi', ...fields });
      created++;
    }
  });
  // An import-sourced request whose (method,path) no longer exists in the spec
  // (renamed/removed endpoint) would otherwise stay verified and FAIL the
  // regression run against a dead path. Drop it from the battery — keep the
  // row (and any manual edits) but clear its verification. Manual requests are
  // never touched.
  let stale = 0;
  for (const r of existing) {
    if (r.source === 'openapi' && r.verified && !matched.has(`${r.method} ${r.path_template}`)) {
      store.unverifyRequest(r.id);
      stale++;
    }
  }
  return { created, updated, stale };
}

export interface ImportOutcome {
  collectionId: number;
  requestCount: number;
  created: number;
  updated: number;
  /** Previously-verified requests dropped from the battery (endpoint vanished). */
  stale: number;
  sourcePath: string;
  /** True when this source was imported before and the spec content changed. */
  specChanged: boolean;
}

/** Parse raw spec → upsert collection (keyed by sourceKey) → reconcile. Shared
 *  by the project-root import and the uploaded-file import. */
async function finalizeImport(
  store: ApiClientStore,
  projectId: number,
  raw: string,
  format: 'yaml' | 'json',
  sourceKey: string,
  beforeWrite?: () => void,
): Promise<ImportOutcome | { error: string }> {
  let parsed;
  try { parsed = await parseOpenApi(raw, format); }
  catch (e) { return { error: `spec parse failed: ${e instanceof Error ? e.message : String(e)}` }; }

  // All writes in ONE transaction — a 300-endpoint spec is one commit instead of
  // ~600 (insert/update per op + the collection upsert), turning a multi-hundred-ms
  // import into a single bulk write.
  return store.transaction(() => {
    beforeWrite?.();
    const prior = store.listCollections(projectId).find((col) => col.spec_source === sourceKey);
    const specChanged = prior != null && prior.spec_hash !== parsed.hash;
    const collection = prior ?? store.createCollection({
      project_id: projectId,
      name: `OpenAPI (${sourceKey})`,
      spec_source: sourceKey,
      spec_hash: parsed.hash,
    });
    store.updateCollection(collection.id, { spec_source: sourceKey, spec_hash: parsed.hash });

    const { created, updated, stale } = reconcileOperations(store, collection.id, parsed.operations);
    return { collectionId: collection.id, requestCount: parsed.operations.length, created, updated, stale, sourcePath: sourceKey, specChanged };
  });
}

/** Probe the project root → import. Returns an error object on failure. */
export async function importOpenApiInto(
  store: ApiClientStore,
  opts: {
    projectId: number;
    rootPath: string;
    specPath?: string;
    signal?: AbortSignal;
    beforeWrite?: () => void;
  },
): Promise<ImportOutcome | { error: string }> {
  const probed = await probeOpenApiOnHost(opts.rootPath, opts.specPath, opts.signal);
  if (!probed) return { error: 'no OpenAPI/Swagger spec found in the project root' };
  return finalizeImport(
    store,
    opts.projectId,
    probed.raw,
    probed.format,
    probed.relPath,
    opts.beforeWrite,
  );
}

/** Import from raw spec content (an uploaded file picked in the UI). Format is
 *  inferred from the filename extension, falling back to a content sniff. */
export async function importOpenApiContent(
  store: ApiClientStore,
  opts: {
    projectId: number;
    content: string;
    filename?: string;
    beforeWrite?: () => void;
  },
): Promise<ImportOutcome | { error: string }> {
  const raw = opts.content ?? '';
  if (!raw.trim()) return { error: 'the selected file is empty' };
  const format = detectFormat(opts.filename, raw);
  const name = opts.filename ? basename(opts.filename) : 'openapi';
  return finalizeImport(
    store,
    opts.projectId,
    raw,
    format,
    `upload:${name}`,
    opts.beforeWrite,
  );
}

function detectFormat(filename: string | undefined, raw: string): 'yaml' | 'json' {
  const ext = (filename ?? '').toLowerCase();
  if (ext.endsWith('.json')) return 'json';
  if (ext.endsWith('.yaml') || ext.endsWith('.yml')) return 'yaml';
  return raw.trimStart().startsWith('{') ? 'json' : 'yaml';
}
