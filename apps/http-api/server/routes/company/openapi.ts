/**
 * OpenAPI document route for the API Reference tab.
 *
 * Probes a fixed set of conventional paths inside the service's workdir
 * and returns the first one that parses. The read goes through the
 * sandbox driver so it works for both OCI (local bind-mount) and E2B
 * (remote workdir). Returning JSON from a YAML source means the
 * dashboard's renderer (Scalar) doesn't need a YAML parser.
 *
 * Phase 8: extracted from the legacy `sessions.ts` mega-file. The
 * `yaml` package import stays dynamic so the http-api boot path
 * doesn't pull it in — the API Reference tab is the only consumer.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { getSandboxManager } from '@mcp/services/sandbox/index.js';
import { parseIdParam, notFound } from '../_helpers.js';

const OPENAPI_CANDIDATES: ReadonlyArray<string> = [
  'openapi.yaml',
  'openapi.yml',
  'openapi.json',
  'docs/openapi.yaml',
  'docs/openapi.yml',
  'docs/openapi.json',
  'api/openapi.yaml',
  'api/openapi.yml',
  'api/openapi.json',
];

async function parseOpenApiYaml(raw: string): Promise<unknown> {
  const mod = (await import('yaml')) as { parse: (s: string) => unknown };
  return mod.parse(raw);
}

export function mountCompanyOpenApiRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore } = deps;

  app.get('/api/company/sessions/:id/services/:serviceId/openapi', async (c) => {
    const id = parseIdParam(c);
    const serviceId = c.req.param('serviceId');
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);

    const manager = getSandboxManager();
    const sb =
      serviceId === 'main'
        ? manager.get(String(id))
        : manager.getService(String(id), serviceId);
    if (!sb) {
      return c.json({ error: 'service_not_running', searchedPaths: [] }, 404);
    }

    const { resolveDriver } = await import('@mcp/services/sandbox/drivers/driver-factory.js');
    const driver = await resolveDriver();

    const tried: string[] = [];
    for (const rel of OPENAPI_CANDIDATES) {
      const abs = `${sb.workdir.replace(/\/+$/, '')}/${rel}`;
      tried.push(rel);
      let raw: string;
      try {
        raw = await driver.readFile(sb.containerId, abs);
      } catch {
        continue;
      }
      try {
        const spec = rel.endsWith('.json') ? JSON.parse(raw) : await parseOpenApiYaml(raw);
        return c.json({ spec, sourcePath: rel });
      } catch (e) {
        return c.json(
          {
            error: 'spec_parse_error',
            sourcePath: rel,
            message: e instanceof Error ? e.message : String(e),
          },
          422,
        );
      }
    }
    return c.json({ error: 'openapi_not_found', searchedPaths: tried }, 404);
  });
}
