import type { HttpContext, HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../../deps.js';
import { getSandboxManager } from '@mcp/services/sandbox/index.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import type { CompanySessionId } from '@mcp/session-storage';
import {
  parseCompanySessionIdParam,
  parseJsonBody,
  notFound,
} from '../_helpers.js';
import { appOwnedControlPlaneConflict } from './runtime-capabilities.js';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface EnvRouteContext {
  requestedId: CompanySessionId;
  rootId: CompanySessionId;
  files: CompanySessionFiles;
  appOwned: boolean;
}

export function mountCompanyEnvsRoutes(app: HttpRouter, deps: ServerDeps): void {
  const { sessionStore, companySessionEnvStore } = deps;

  const resolveEnv = async (c: HttpContext): Promise<EnvRouteContext | null> => {
    const requestedId = parseCompanySessionIdParam(c);
    await sessionStore.ensureCatalog();
    let requestedFiles: CompanySessionFiles;
    try {
      requestedFiles = new CompanySessionFiles({
        companySessionId: requestedId,
        sessionStore,
      });
    } catch {
      return null;
    }
    const requested = requestedFiles.getSession();
    const rootId = requested.parent_session_id ?? requestedId;
    let files = requestedFiles;
    if (rootId !== requestedId) {
      try {
        files = new CompanySessionFiles({
          companySessionId: rootId,
          sessionStore,
        });
      } catch {
        return null;
      }
    }
    return {
      requestedId,
      rootId,
      files,
      appOwned: files.getSession().runtime_kind === 'app_studio',
    };
  };

  app.get('/api/company/sessions/:id/envs', async (c) => {
    const resolved = await resolveEnv(c);
    if (!resolved) return notFound(c);
    const reveal = c.req.query('reveal') === '1';
    if (reveal && resolved.appOwned) {
      return appOwnedControlPlaneConflict(c, 'environment secret reveal');
    }
    const keyFilter = c.req.query('key');
    const all = await companySessionEnvStore.listAsync(resolved.rootId);
    const rows = keyFilter ? all.filter((row) => row.key === keyFilter) : all;
    if (reveal) {
      const secretKeys = rows
        .filter((row) => row.is_secret)
        .map((row) => row.key);
      if (secretKeys.length > 0) {
        console.warn(
          `[env-audit] session ${resolved.rootId}: secret reveal — keys: ${secretKeys.join(', ')}`,
        );
        try {
          resolved.files.createBoardEntry({
            authorRole: 'system',
            agentRunId: null,
            kind: 'message',
            content:
              `Env secret value(s) revealed in the dashboard: ${secretKeys.join(', ')}`,
          });
        } catch {
          // Console audit above is always retained even if the board is unavailable.
        }
      }
    }
    return c.json({
      envs: rows.map((row) => ({
        id: row.id,
        seq: row.seq,
        key: row.key,
        value: row.is_secret && !reveal ? '' : row.value,
        is_secret: !!row.is_secret,
        masked: !!row.is_secret && !reveal,
        source: row.source,
        service_scope: row.service_scope,
        updated_at: row.updated_at,
      })),
    });
  });

  app.put('/api/company/sessions/:id/envs/:key', async (c) => {
    const resolved = await resolveEnv(c);
    if (!resolved) return notFound(c);
    if (resolved.appOwned) {
      return appOwnedControlPlaneConflict(c, 'environment configuration');
    }
    const key = c.req.param('key');
    if (!key || !KEY_RE.test(key)) {
      return c.json(
        { error: `Invalid key '${key}'. Use letters/digits/underscore only.` },
        400,
      );
    }
    const body = await parseJsonBody<{
      value?: string;
      is_secret?: boolean;
      service_scope?: string | null;
    }>(c);
    if (typeof body.value !== 'string') {
      return c.json({ error: 'value (string) required' }, 400);
    }
    if (
      'service_scope' in body &&
      body.service_scope !== null &&
      typeof body.service_scope !== 'string'
    ) {
      return c.json(
        { error: 'service_scope must be null or a CSV string of service ids' },
        400,
      );
    }
    await companySessionEnvStore.upsert(
      resolved.rootId,
      key,
      body.value,
      !!body.is_secret,
      {
        serviceScope:
          'service_scope' in body ? body.service_scope : undefined,
      },
    );
    const application = await getSandboxManager().syncEnvsToAllContainers(resolved.rootId).catch(() => ({ state: 'failed', applied: [], failed: [{ serviceId: '*', reason: 'environment_sync_failed' }], restartRequired: false }));
    return c.json({ ok: true, persisted: true, application });
  });

  app.delete('/api/company/sessions/:id/envs/:key', async (c) => {
    const resolved = await resolveEnv(c);
    if (!resolved) return notFound(c);
    if (resolved.appOwned) {
      return appOwnedControlPlaneConflict(c, 'environment configuration');
    }
    const key = c.req.param('key');
    if (!key) return c.json({ error: 'key required' }, 400);
    companySessionEnvStore.delete(resolved.rootId, key);
    const application = await getSandboxManager().syncEnvsToAllContainers(resolved.rootId).catch(() => ({ state: 'failed', applied: [], failed: [{ serviceId: '*', reason: 'environment_sync_failed' }], restartRequired: false }));
    return c.json({ ok: true, persisted: true, application });
  });
}
