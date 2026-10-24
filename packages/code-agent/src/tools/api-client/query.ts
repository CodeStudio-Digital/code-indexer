/**
 * Read tools — list a collection's requests (with verification state) and
 * fetch one request's full detail. No mutations, no network.
 */
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { resolveApiCtx, projectCollection, projectRequest } from './shared.js';

export const apiListRequestsTool: CoderTool = {
  name: 'api_list_requests',
  description:
    'List the requests in an API-client collection with their method, path, verification state (✓ verified / ✗ not), and last observed status. Use after api_import_openapi to see what to test.',
  source: 'native',
  mutates: false,
  parallelSafe: true,
  riskLevel: 'read',
  parameters: {
    type: 'object',
    properties: {
      collectionId: { type: 'number', description: 'Collection id (from api_import_openapi).' },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Page size, default 100.' },
      offset: { type: 'integer', minimum: 0, description: 'Page offset, default 0.' },
    },
    required: ['collectionId'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const r = resolveApiCtx(ctx);
    if ('error' in r) return err(r.error);
    const collection = projectCollection(r, Number(args.collectionId));
    if (!collection) return err('Collection not found in this project.');
    const limit = Number.isSafeInteger(args.limit) ? Math.min(500, Math.max(1, Number(args.limit))) : 100;
    const offset = Number.isSafeInteger(args.offset) ? Math.max(0, Number(args.offset)) : 0;
    const page = r.store.listRequestSummaries(collection.id, limit + 1, offset);
    const reqs = page.slice(0, limit);
    if (reqs.length === 0) return ok('(no requests in this collection)');
    const lines = reqs.map((q) =>
      `#${q.id} ${q.method} ${q.path_template} | ${q.verified ? `✓ expect ${q.expected_status}` : '✗ unverified'}${q.last_status != null ? ` | last ${q.last_status}` : ''} | ${q.name}`,
    );
    if (page.length > limit) lines.push(`[More requests available: use offset ${offset + limit}, limit ${limit}.]`);
    return ok(lines.join('\n'));
  },
};

export const apiGetRequestTool: CoderTool = {
  name: 'api_get_request',
  description: 'Full detail of one API-client request: method, path, headers, query, body and verification state.',
  source: 'native',
  mutates: false,
  parallelSafe: true,
  riskLevel: 'read',
  parameters: {
    type: 'object',
    properties: { requestId: { type: 'number' } },
    required: ['requestId'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const r = resolveApiCtx(ctx);
    if ('error' in r) return err(r.error);
    const q = projectRequest(r, Number(args.requestId));
    if (!q) return err(`request ${args.requestId} not found`);
    return ok(JSON.stringify({
      id: q.id, name: q.name, method: q.method, path_template: q.path_template,
      headers: q.headers_json, query: q.query_json, body: q.body_json, body_kind: q.body_kind,
      verified: q.verified, expected_status: q.expected_status, assert: q.assert_json, last_status: q.last_status,
    }, null, 2));
  },
};
