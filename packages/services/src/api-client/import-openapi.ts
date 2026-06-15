/**
 * importOpenApiInto — discover + parse an OpenAPI/Swagger spec and reconcile
 * its operations into a collection. Shared by the HTTP import route and the
 * `api_import_openapi` agent tool so there's one idempotent implementation.
 *
 * Idempotent: a collection previously imported from the same source path is
 * reused; verified requests are NEVER overwritten (their fix/verification
 * survives re-import); new operations are inserted, unverified ones refreshed.
 */
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

/** Probe → parse → upsert collection → reconcile. Returns a string on failure. */
export async function importOpenApiInto(
  store: ApiClientStore,
  opts: { projectId: number; rootPath: string; specPath?: string },
): Promise<ImportOutcome | { error: string }> {
  const probed = await probeOpenApiOnHost(opts.rootPath, opts.specPath);
  if (!probed) return { error: 'no OpenAPI/Swagger spec found in the project root' };

  let parsed;
  try { parsed = await parseOpenApi(probed.raw, probed.format); }
  catch (e) { return { error: `spec parse failed: ${e instanceof Error ? e.message : String(e)}` }; }

  const prior = store.listCollections(opts.projectId).find((col) => col.spec_source === probed.relPath);
  const specChanged = prior != null && prior.spec_hash !== parsed.hash;
  const collection = prior ?? store.createCollection({
    project_id: opts.projectId,
    name: `OpenAPI (${probed.relPath})`,
    spec_source: probed.relPath,
    spec_hash: parsed.hash,
  });
  store.updateCollection(collection.id, { spec_source: probed.relPath, spec_hash: parsed.hash });

  const { created, updated, stale } = reconcileOperations(store, collection.id, parsed.operations);
  return { collectionId: collection.id, requestCount: parsed.operations.length, created, updated, stale, sourcePath: probed.relPath, specChanged };
}
