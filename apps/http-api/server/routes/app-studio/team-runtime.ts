import type { Context, Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, notFound } from '../_helpers.js';
import { abortCompanyRuntime } from '../company/runtime-lifecycle.js';

type TeamRuntimeProxyTarget =
  | ''
  | '/state-snapshot'
  | '/status'
  | '/events.jsonl'
  | '/events-summary'
  | '/attach'
  | '/start'
  | '/resume'
  | '/message'
  | '/answer'
  | '/plan-response'
  | '/wake-master';

export interface AppTeamRuntimeBinding {
  appSessionId: number;
  companySessionId: number;
}

type AppTeamRuntimeBindingResult =
  | { ok: true; binding: AppTeamRuntimeBinding }
  | {
      ok: false;
      status: 404 | 409;
      error: string;
      code: 'APP_SESSION_NOT_FOUND' | 'APP_TEAM_NOT_READY' | 'APP_TEAM_LINK_INVALID';
    };

/**
 * Resolve the server-owned App -> Company relationship. The Company id never
 * comes from the client, and both sides of the unique link must agree. This is
 * the authorization boundary that prevents one App from driving another App's
 * team through the facade.
 */
export function resolveAppTeamRuntimeBinding(
  deps: Pick<ServerDeps, 'appStudioStore' | 'companyStore'>,
  appSessionId: number,
): AppTeamRuntimeBindingResult {
  const appSession = deps.appStudioStore.getSession(appSessionId);
  if (!appSession) {
    return {
      ok: false,
      status: 404,
      error: 'App Studio session not found.',
      code: 'APP_SESSION_NOT_FOUND',
    };
  }
  if (appSession.company_session_id == null) {
    return {
      ok: false,
      status: 409,
      error: 'The App team is not ready yet.',
      code: 'APP_TEAM_NOT_READY',
    };
  }

  const companySession = deps.companyStore.getCompanySession(appSession.company_session_id);
  const reverseLink = deps.appStudioStore.getSessionByCompanySessionId(appSession.company_session_id);
  if (
    !companySession
    || companySession.runtime_kind !== 'app_studio'
    || reverseLink?.id !== appSessionId
  ) {
    return {
      ok: false,
      status: 409,
      error: 'The persistent team link is invalid.',
      code: 'APP_TEAM_LINK_INVALID',
    };
  }

  return {
    ok: true,
    binding: {
      appSessionId,
      companySessionId: companySession.id,
    },
  };
}

function bindingOrResponse(c: Context, deps: ServerDeps): AppTeamRuntimeBinding | Response {
  const resolved = resolveAppTeamRuntimeBinding(deps, parseIdParam(c));
  if (resolved.ok) return resolved.binding;
  if (resolved.status === 404) return notFound(c, resolved.error);
  return c.json({ error: resolved.error, code: resolved.code }, resolved.status);
}

/**
 * Forward to the already-mounted Company route after resolving the binding.
 * This deliberately reuses its validation, idempotency, attachment handling,
 * master recovery and replay pump instead of copying lifecycle logic into App
 * Studio. Returning the nested Response preserves the SSE body and event ids.
 */
async function proxyCompanyRuntimeRoute(
  app: Hono,
  c: Context,
  companySessionId: number,
  target: TeamRuntimeProxyTarget,
): Promise<Response> {
  const source = new URL(c.req.url);
  source.pathname = `/api/company/sessions/${companySessionId}${target}`;

  const method = c.req.method.toUpperCase();
  const body = method === 'GET' || method === 'HEAD'
    ? undefined
    : await c.req.raw.arrayBuffer();
  const headers = new Headers(c.req.raw.headers);
  // The byte-for-byte body is preserved, but the browser may have supplied a
  // transport-specific host. Let the nested request calculate those fields.
  headers.delete('host');

  return app.request(new Request(source, {
    method,
    headers,
    body,
    signal: c.req.raw.signal,
  }));
}

export function mountAppStudioTeamRuntimeRoutes(app: Hono, deps: ServerDeps): void {
  const proxy = (target: TeamRuntimeProxyTarget) => async (c: Context) => {
    const binding = bindingOrResponse(c, deps);
    if (binding instanceof Response) return binding;
    return proxyCompanyRuntimeRoute(app, c, binding.companySessionId, target);
  };

  // Durable state/provenance projection. `state` returns the full Company
  // envelope, including configured/effective provider+model per agent run.
  app.get('/api/app-studio/apps/:id/team/commands/state', proxy(''));
  app.get('/api/app-studio/apps/:id/team/commands/state-snapshot', proxy('/state-snapshot'));
  app.get('/api/app-studio/apps/:id/team/commands/status', proxy('/status'));
  app.get('/api/app-studio/apps/:id/team/commands/events.jsonl', proxy('/events.jsonl'));
  app.get('/api/app-studio/apps/:id/team/commands/events-summary', proxy('/events-summary'));

  // Real multiplexed Company stream. `Last-Event-ID` and query params survive
  // the proxy, so attach/start/resume retain the Company's bounded replay and
  // idempotent reconnect behavior.
  app.get('/api/app-studio/apps/:id/team/commands/attach', proxy('/attach'));
  app.post('/api/app-studio/apps/:id/team/commands/start', proxy('/start'));
  app.post('/api/app-studio/apps/:id/team/commands/resume', proxy('/resume'));
  app.post('/api/app-studio/apps/:id/team/commands/message', proxy('/message'));
  app.post('/api/app-studio/apps/:id/team/commands/answer', proxy('/answer'));
  app.post('/api/app-studio/apps/:id/team/commands/plan-response', proxy('/plan-response'));
  app.post('/api/app-studio/apps/:id/team/commands/wake-master', proxy('/wake-master'));

  // Generic Company intentionally blocks destructive control of App-owned
  // sessions. The App facade performs the link authorization above, then calls
  // the shared abort primitive directly.
  app.post('/api/app-studio/apps/:id/team/commands/abort', (c) => {
    const binding = bindingOrResponse(c, deps);
    if (binding instanceof Response) return binding;
    const result = abortCompanyRuntime(binding.companySessionId);
    if (!result.ok) return c.json({ error: 'No active orchestrator' }, 404);
    return c.json({ ok: true });
  });
}
