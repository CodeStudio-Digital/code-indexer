/**
 * Execute tools — hit the LIVE dev server. `api_run_request` sends one request
 * and returns the real response (the agent reads it to decide a fix or to
 * verify). `api_run_collection` replays the whole collection through the
 * non-LLM regression runner and reports pass/fail.
 */
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { executeRequest } from '@mcp/services/api-client/execute-request.js';
import { runCollection } from '@mcp/services/api-client/regression-runner.js';
import { apiClientReadCap } from '@mcp/services/api-client/read-cap.js';
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
    let res;
    try {
      // Contain file-backed bodies to the project root — the agent must not be
      // able to read an arbitrary host file (e.g. ~/.ssh/id_rsa) and POST it out.
      res = await executeRequest({
        request: req, baseUrl, variables, jar: jarForProject(r.projectId), signal: ctx.signal,
        fileRoot: ctx.cwd, allowAbsoluteFiles: false, maxBytes: apiClientReadCap(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/Invalid URL|resolve/i.test(msg) && !/ECONN|timed out|socket/i.test(msg)) {
        return err(`could not resolve URL from base '${baseUrl}' + path '${req.path_template}'. Create/select an environment with a base_url.`);
      }
      return err(`request failed: ${msg}`);
    }
    r.store.updateRequest(req.id, { last_status: res.status, last_run_at: new Date().toISOString() });

    const out = res.body.length > BODY_CAP ? `${res.body.slice(0, BODY_CAP)}\n… [truncated ${res.body.length - BODY_CAP} chars]` : res.body;
    const ct = String(res.headers['content-type'] ?? '');
    const tests = [...(res.preScript?.tests ?? []), ...(res.testScript?.tests ?? [])];
    const testLine = tests.length ? `tests: ${tests.filter((t) => t.passed).length}/${tests.length} passed` : '';
    // Echo origin+path only — res.url is fully resolved (apikey-in-query / {{secret}}
    // in a param), and this line goes to the AI provider in cleartext.
    let shownUrl = res.url;
    try { const u = new URL(res.url); shownUrl = `${u.origin}${u.pathname}`; } catch { shownUrl = res.url.split('?')[0]; }
    return ok([
      `${req.method} ${shownUrl} → ${res.status} ${res.statusText} (${res.ms}ms)`,
      ct ? `content-type: ${ct}` : '',
      testLine,
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
        fileRoot: ctx.cwd, allowAbsoluteFiles: false, maxBytes: apiClientReadCap(),
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
    const ranResults = report.results.filter((x) => !x.skipped && x.actual != null);
    if (ranResults.length) {
      const now = new Date().toISOString();
      r.store.transaction(() => {
        for (const x of ranResults) r.store.updateRequest(x.requestId, { last_status: x.actual, last_run_at: now });
      });
    }

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
