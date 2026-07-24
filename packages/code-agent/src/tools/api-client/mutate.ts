/**
 * Write tools — import an OpenAPI spec into a collection, patch a request (the
 * FIX action), and pin a verified expected status. These mutate saved state
 * but make no network calls.
 */
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { importOpenApiInto } from '@mcp/services/api-client/import-openapi.js';
import { resolveApiCtx } from './shared.js';
import { assertMutationFence } from '@mcp/code-agent/core/mutation-fence.js';

export const apiImportOpenApiTool: CoderTool = {
  name: 'api_import_openapi',
  effectBoundary: 'control',
  description:
    'Discover an OpenAPI/Swagger spec under the project root and import it into a collection (one request per operation). Idempotent: re-import preserves already-verified requests. Returns the collectionId to test against.',
  source: 'native',
  mutates: true,
  parallelSafe: false,
  riskLevel: 'write',
  parameters: {
    type: 'object',
    properties: { specPath: { type: 'string', description: 'Relative path to the spec (optional — auto-detects openapi.yaml / docs/openapi.json / swagger.json …).' } },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const r = resolveApiCtx(ctx);
    if ('error' in r) return err(r.error);
    const outcome = await importOpenApiInto(r.store, {
      projectId: r.projectId,
      rootPath: ctx.cwd,
      specPath: typeof args.specPath === 'string' ? args.specPath : undefined,
      beforeWrite: () => assertMutationFence(ctx.mutationFence, {
        kind: 'control',
        operation: 'api_import_openapi.write',
        resource: String(r.projectId),
      }),
    });
    if ('error' in outcome) return err(outcome.error);
    const staleNote = outcome.stale ? ` ${outcome.stale} removed endpoint(s) were dropped from the regression battery.` : '';
    return ok(`Imported ${outcome.requestCount} operations from ${outcome.sourcePath} into collection #${outcome.collectionId} (${outcome.created} new, ${outcome.updated} updated).${staleNote} Run api_list_requests ${outcome.collectionId} to see them.`);
  },
};

export const apiUpdateRequestTool: CoderTool = {
  name: 'api_update_request',
  effectBoundary: 'control',
  description:
    'Patch a request to fix it — add a missing required param, correct a header/body/path/method the spec got wrong. Pass only the fields to change. headers/query are objects; body is a string. After fixing, re-run with api_run_request.',
  source: 'native',
  mutates: true,
  parallelSafe: false,
  riskLevel: 'write',
  parameters: {
    type: 'object',
    properties: {
      requestId: { type: 'number' },
      method: { type: 'string' },
      path_template: { type: 'string' },
      headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Full header map (replaces existing).' },
      query: { type: 'object', additionalProperties: { type: 'string' }, description: 'Full query map (replaces existing).' },
      body: { type: 'string', description: 'Raw/JSON body string.' },
      bodyKind: { type: 'string', enum: ['none', 'json', 'raw', 'form-data', 'urlencoded', 'graphql', 'binary'] },
    },
    required: ['requestId'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const r = resolveApiCtx(ctx);
    if ('error' in r) return err(r.error);
    const rid = Number(args.requestId);
    if (!r.store.getRequest(rid)) return err(`request ${rid} not found`);
    const patch: Record<string, unknown> = {};
    if (typeof args.method === 'string') patch.method = args.method.toUpperCase();
    if (typeof args.path_template === 'string') patch.path_template = args.path_template;
    if (args.headers && typeof args.headers === 'object') patch.headers_json = JSON.stringify(args.headers);
    if (args.query && typeof args.query === 'object') patch.query_json = JSON.stringify(args.query);
    if (typeof args.body === 'string') patch.body_json = args.body;
    if (typeof args.bodyKind === 'string') patch.body_kind = args.bodyKind;
    assertMutationFence(ctx.mutationFence, {
      kind: 'control',
      operation: 'api_update_request.write',
      resource: String(rid),
    });
    r.store.updateRequest(rid, patch);
    return ok(`request #${rid} updated (${Object.keys(patch).join(', ') || 'no changes'})`);
  },
};

export const apiMarkVerifiedTool: CoderTool = {
  name: 'api_mark_verified',
  effectBoundary: 'control',
  description:
    'Pin a request as verified with its expected status (and an optional response-shape skeleton like {"id":"number","name":"string"}). Verified requests form the non-LLM regression battery. Call this once a request returns the right status against the live server.',
  source: 'native',
  mutates: true,
  parallelSafe: false,
  riskLevel: 'write',
  parameters: {
    type: 'object',
    properties: {
      requestId: { type: 'number' },
      expectedStatus: { type: 'number', description: 'The status the regression runner should assert (e.g. 200).' },
      shape: { type: 'object', description: 'Optional response skeleton: keys → JS type names (string/number/boolean/object/array).' },
    },
    required: ['requestId', 'expectedStatus'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const r = resolveApiCtx(ctx);
    if ('error' in r) return err(r.error);
    const rid = Number(args.requestId);
    if (!r.store.getRequest(rid)) return err(`request ${rid} not found`);
    const assert = args.shape && typeof args.shape === 'object' ? JSON.stringify({ shape: args.shape }) : null;
    assertMutationFence(ctx.mutationFence, {
      kind: 'control',
      operation: 'api_mark_verified.write',
      resource: String(rid),
    });
    r.store.markVerified(rid, Number(args.expectedStatus), assert);
    return ok(`request #${rid} verified (expect ${args.expectedStatus})`);
  },
};
