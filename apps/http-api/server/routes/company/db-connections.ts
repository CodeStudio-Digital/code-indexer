/**
 * Read-only view of the database connections visible to a company session.
 *
 *   GET /api/company/sessions/:id/db-connections
 *
 * Company sessions no longer OWN database registrations (the old
 * session-scoped Databases tab + `company_session_databases` table are
 * retired — migration 191). Connections belong to PROJECTS (Databases tab,
 * migration 174) and the `db_*` agent tools read them through the linked
 * projects of the session. This route surfaces exactly that same scope so
 * the operator can see what the agents can reach — metadata only:
 * NEVER the `enc_*` columns, and there is no `?reveal` variant.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, notFound, resolveRootSessionId } from '../_helpers.js';
import { engineKind } from '@mcp/code-agent/tools/db/scope.js';

interface CompanyDbConnectionView {
  projectId: number;
  /** Link label of the project in this session (often the service id), or the project name. */
  projectLabel: string;
  label: string;
  engine: string;
  /** Host for server engines; file path for sqlite. */
  host: string | null;
  database: string | null;
  is_read_only: boolean;
  kind: 'relational' | 'document' | 'keyvalue';
}

export function mountCompanyDbConnectionsRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore, dbClientFor, db } = deps;

  app.get('/api/company/sessions/:id/db-connections', (c) => {
    const id = resolveRootSessionId(companyStore, parseIdParam(c));
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);

    const connections: CompanyDbConnectionView[] = [];
    for (const link of companyStore.listCompanySessionProjects(id)) {
      const projectLabel =
        link.label?.trim() ||
        db.getProject(link.project_id)?.name ||
        `project-${link.project_id}`;
      // Same store instances the project's Databases tab handlers use
      // (per-project DB routing included) — the agents' db_* tools read
      // the identical rows, so this list is what the session can reach.
      let rows: ReturnType<ReturnType<typeof dbClientFor>['listConnections']>;
      try {
        rows = dbClientFor(link.project_id).listConnections(link.project_id);
      } catch {
        continue; // unreadable project DB → skip, never 500 the whole list
      }
      for (const conn of rows) {
        connections.push({
          projectId: link.project_id,
          projectLabel,
          label: conn.label,
          engine: conn.engine,
          host: conn.engine === 'sqlite' ? conn.file_path : conn.host,
          database: conn.database_name,
          is_read_only: conn.is_read_only === 1,
          kind: engineKind(conn.engine),
        });
      }
    }
    return c.json({ connections });
  });
}
