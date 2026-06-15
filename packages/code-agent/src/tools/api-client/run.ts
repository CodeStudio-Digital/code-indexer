/**
 * Execute tools — hit the LIVE dev server. `api_run_request` sends one request
 * and returns the real response (the agent reads it to decide a fix or to
 * verify). `api_run_collection` replays the whole collection through the
 * non-LLM regression runner and reports pass/fail.
 */
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { sendHttp } from '@mcp/shared/utils/http-engine.js';
import { buildUrl, parseMap, resolveMap, resolveTemplate } from '@mcp/services/api-client/request-builder.js';
import { runCollection } from '@mcp/services/api-client/regression-runner.js';
import { resolveApiCtx, jarForProject, resolveEnvFor } from './shared.js';

const BODY_CAP = 4096;

export const apiRunRequestTool: CoderTool = {
  name: 'api_run_request',
  description:
    'Send ONE request against the live dev server and return the real status, headers and body. Use this to probe an endpoint: a 400/422 usually means the spec omitted a required param (fix with api_update_request, then re-run); a 2xx that looks right → api_mark_verified. The per-project cookie jar persists logins across calls.',
  source: 'native',
  mutates: false,
  parallelSafe: false,
  riskLevel: 'execute',
  parameters: {
    type: 'object',
    properties: {
      requestId: { type: 'number' },
      envId: { type: 'number', description: 'Environment to resolve {{vars}} + base URL (default: the project default env).' },
    },
    required: ['requestId'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const r = resolveApiCtx(ctx);
    if ('error' in r) return err(r.error);
    const req = r.store.getRequest(Number(args.requestId));
    if (!req) return err(`request ${args.requestId} not found`);

    const { baseUrl, variables } = resolveEnvFor(r.store, r.projectId, args.envId != null ? Number(args.envId) : undefined);
    let url: URL;
    try { url = buildUrl(baseUrl, req.path_template, parseMap(req.query_json), variables); }
    catch { return err(`could not resolve URL from base '${baseUrl}' + path '${req.path_template}'. Create/select an environment with a base_url.`); }

    const headers = resolveMap(parseMap(req.headers_json), variables);
    let body: string | undefined;
    if (req.body_kind !== 'none' && req.body_json != null) {
      body = resolveTemplate(req.body_json, variables);
      if (req.body_kind === 'json' && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json';
      }
    }

    const t0 = Date.now();
    let res;
    try { res = await sendHttp({ url, method: req.method, headers, body, jar: jarForProject(r.projectId), signal: ctx.signal }); }
    catch (e) { return err(`request failed: ${e instanceof Error ? e.message : String(e)}`); }
    r.store.updateRequest(req.id, { last_status: res.status, last_run_at: new Date().toISOString() });

    const out = res.body.length > BODY_CAP ? `${res.body.slice(0, BODY_CAP)}\n… [truncated ${res.body.length - BODY_CAP} chars]` : res.body;
    const ct = String(res.headers['content-type'] ?? '');
    return ok([
      `${req.method} ${url.href} → ${res.status} ${res.statusText} (${Date.now() - t0}ms)`,
      ct ? `content-type: ${ct}` : '',
      '',
      out || '(empty body)',
    ].filter(Boolean).join('\n'));
  },
};

export const apiRunCollectionTool: CoderTool = {
  name: 'api_run_collection',
  description:
    'Replay all VERIFIED requests in a collection through the non-LLM regression runner and report pass/fail. Mutating methods (POST/PUT/DELETE) are skipped unless includeMutating is true. Use this to confirm the whole surface is green after fixing.',
  source: 'native',
  mutates: true,
  parallelSafe: false,
  riskLevel: 'execute',
  parameters: {
    type: 'object',
    properties: {
      collectionId: { type: 'number' },
      envId: { type: 'number' },
      includeMutating: { type: 'boolean', description: 'Also run POST/PUT/PATCH/DELETE (default false — they are skipped).' },
    },
    required: ['collectionId'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const r = resolveApiCtx(ctx);
    if ('error' in r) return err(r.error);
    const cid = Number(args.collectionId);
    if (!r.store.getCollection(cid)) return err(`collection ${cid} not found`);
    const { baseUrl, variables, envId } = resolveEnvFor(r.store, r.projectId, args.envId != null ? Number(args.envId) : undefined);

    const runId = r.store.createRun(cid, envId, 'agent');
    let report;
    try {
      report = await runCollection({
        requests: r.store.listRequests(cid),
        baseUrl, variables,
        jar: jarForProject(r.projectId),
        includeMutating: !!args.includeMutating,
        signal: ctx.signal,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      r.store.finishRun(runId, { status: 'error', total: 0, passed: 0, failed: 0, results_json: JSON.stringify([{ reason: message }]) });
      return err(`regression run failed: ${message}`);
    }
    r.store.finishRun(runId, {
      status: report.status, total: report.total, passed: report.passed,
      failed: report.failed, results_json: JSON.stringify(report.results),
    });

    if (report.passed === 0 && report.failed === 0) {
      return ok(`Regression run #${runId}: nothing ran — no verified requests in collection ${cid}. Run each request and api_mark_verified the good ones first.`);
    }
    const failing = report.results.filter((x) => !x.ok && !x.skipped).map((x) => `  ✗ ${x.method} ${x.name}: ${x.reason ?? 'failed'}`);
    return ok([
      `Regression run #${runId}: ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped (${report.status}).`,
      ...failing,
    ].join('\n'));
  },
};
