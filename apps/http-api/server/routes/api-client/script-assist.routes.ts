import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody } from '../_helpers.js';
import { callGeneralAiJson, stripJsonFences } from '@mcp/api-handlers/aiJson.js';

/**
 * Focused, tool-less AI helper that writes Postman-style `pm.*` scripts for the
 * Scripts tab. One-shot completion via the project's general AI model — no agent
 * loop, no tools. The model is taught ONLY the subset our vm runtime supports.
 */

interface AssistRequest {
  target?: 'pre' | 'test';
  intent?: string;
  request?: { method?: string; url?: string; headerNames?: string[]; bodyKind?: string; bodySample?: string };
  responseShape?: string;
  existing?: string;
}

// The exact pm.* surface implemented in script-runtime/bootstrap.ts.
const PM_API = `Available API (this is NOT full Postman — use ONLY these):
- pm.environment.get(key) / pm.environment.set(key, value) / pm.environment.unset(key)
- pm.variables.get(key)
- pm.cookies.get(name) / pm.cookies.has(name)
- pm.test(name, fn)   // wrap each assertion in a pm.test
- pm.expect(value): chainable .to .be .have .and .not + matchers:
  .equal(x) .eql(x) .ok .true .false .null .undefined .a(type) .an(type)
  .include(x) .property(name[, value]) .above(n) .below(n) .least(n) .most(n) .have.status(code)
- console.log(...)
PRE-REQUEST scripts only: pm.request.url.get()/set(s), pm.request.method.get()/set(s),
  pm.request.headers.get(n)/set(n,v)/remove(n)/all(), pm.request.body.get()/set(s).
TEST scripts only: pm.response.code, pm.response.status, pm.response.responseTime,
  pm.response.headers.get(n)/has(n)/all(), pm.response.text(), pm.response.json().
HARD CONSTRAINTS: synchronous only — NO async/await, Promise, setTimeout, fetch, require, import.
In a TEST script pm.request is read-only and pm.response is available; in a PRE-REQUEST
script pm.response does NOT exist.`;

function buildSystemPrompt(target: 'pre' | 'test'): string {
  const phase = target === 'test'
    ? 'a TEST (post-response) script — assert the response with pm.test + pm.expect, and/or save values to the environment.'
    : 'a PRE-REQUEST script — set up variables/headers before the request runs.';
  return [
    `You are an assistant that writes a single JavaScript ${target === 'test' ? 'test' : 'pre-request'} script for an in-app API client, using a Postman-like "pm" object.`,
    `Write ${phase}`,
    PM_API,
    'Rules: return ONLY valid JSON: {"script": "<the JS>", "explanation": "<one short sentence>"}.',
    'The script must be ready to paste — no markdown fences, no comments unless helpful, only the supported API.',
    'Examples:',
    'TEST → {"script":"pm.test(\\"status is 200\\", () => pm.expect(pm.response).to.have.status(200));","explanation":"Asserts the response status is 200."}',
    'TEST → {"script":"pm.test(\\"has token\\", () => pm.expect(pm.response.json()).to.have.property(\\"token\\"));\\npm.environment.set(\\"token\\", pm.response.json().token);","explanation":"Checks the token field and saves it to {{token}}."}',
    'PRE → {"script":"pm.request.headers.set(\\"X-Request-Id\\", String(Date.now()));","explanation":"Adds a unique request id header."}',
  ].join('\n\n');
}

function buildUserPrompt(b: AssistRequest): string {
  const r = b.request ?? {};
  const lines = [
    `Request: ${r.method ?? 'GET'} ${r.url ?? ''}`.trim(),
    r.headerNames?.length ? `Header names: ${r.headerNames.join(', ')}` : '',
    r.bodyKind && r.bodyKind !== 'none' ? `Body kind: ${r.bodyKind}` : '',
    r.bodySample ? `Body (template, truncated):\n${r.bodySample.slice(0, 1500)}` : '',
    b.responseShape ? `Last response SHAPE (keys+types, no values):\n${b.responseShape.slice(0, 1500)}` : '(no response captured yet)',
    b.existing?.trim() ? `Existing ${b.target === 'test' ? 'test' : 'pre-request'} script (extend, don't duplicate):\n${b.existing.slice(0, 1500)}` : '',
    `\nUser request: ${b.intent ?? ''}`,
  ];
  return lines.filter(Boolean).join('\n');
}

export function mountApiScriptAssistRoute(app: Hono, deps: ServerDeps): void {
  app.post('/api/projects/:projectId/api-client/script-assist', async (c) => {
    parseIdParam(c, 'projectId'); // validate shape (route is project-scoped; the AI call itself isn't store-bound)
    const body = await parseJsonBody<AssistRequest>(c);
    if (!body.intent?.trim()) return c.json({ error: 'Describe what the script should do.' }, 400);
    const target: 'pre' | 'test' = body.target === 'pre' ? 'pre' : 'test';

    const res = await callGeneralAiJson(deps, {
      system: buildSystemPrompt(target),
      user: buildUserPrompt({ ...body, target }),
      maxTokens: 1200,
    });
    if ('refusal' in res) return c.json({ error: res.refusal }, 400);

    try {
      const parsed = JSON.parse(stripJsonFences(res.raw)) as { script?: string; explanation?: string };
      if (!parsed.script?.trim()) return c.json({ error: 'The model returned no script. Try rephrasing.' }, 400);
      return c.json({ script: parsed.script, explanation: parsed.explanation ?? '' });
    } catch {
      return c.json({ error: `Could not parse the model output: ${stripJsonFences(res.raw).slice(0, 200)}` }, 400);
    }
  });
}
