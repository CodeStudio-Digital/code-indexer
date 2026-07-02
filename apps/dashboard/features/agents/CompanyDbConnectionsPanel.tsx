/**
 * CompanyDbConnectionsPanel — READ-ONLY list of the database connections
 * the session's agents can reach, grouped by linked project.
 *
 * Replaces the retired session-scoped DatabasesTab (env-var based CRUD,
 * migration 191): connections are now registered per PROJECT in the
 * project's Databases tab (migration 174), and company sessions only get
 * this projection of them. "Manage" deep-links to the owning project's
 * Databases tab in THIS window (`/projects/:id?tab=databases` — ProjectView
 * honours the `?tab` param); it does not focus other Electron windows.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Database, ExternalLink, Lock, RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui/button.js';

interface DbConnectionView {
  projectId: number;
  projectLabel: string;
  label: string;
  engine: string;
  host: string | null;
  database: string | null;
  is_read_only: boolean;
  kind: 'relational' | 'document' | 'keyvalue';
}

interface CompanyDbConnectionsPanelProps {
  companySessionId: number;
}

export default function CompanyDbConnectionsPanel({ companySessionId }: CompanyDbConnectionsPanelProps) {
  const { t } = useTranslation('agents');
  const navigate = useNavigate();
  const [connections, setConnections] = useState<DbConnectionView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const r = await fetch(`/api/company/sessions/${companySessionId}/db-connections`);
      if (!r.ok) throw new Error(String(r.status));
      const body = (await r.json()) as { connections?: DbConnectionView[] };
      // Defensive defaults — the dashboard has no tsc gate and the API may evolve.
      setConnections(Array.isArray(body?.connections) ? body.connections : []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [companySessionId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Group by project, preserving the API's project order. */
  const groups = useMemo(() => {
    const byProject = new Map<number, { label: string; rows: DbConnectionView[] }>();
    for (const conn of connections) {
      let g = byProject.get(conn.projectId);
      if (!g) {
        g = { label: conn.projectLabel || `project-${conn.projectId}`, rows: [] };
        byProject.set(conn.projectId, g);
      }
      g.rows.push(conn);
    }
    return [...byProject.entries()].map(([projectId, g]) => ({ projectId, ...g }));
  }, [connections]);

  const badge = 'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium';

  return (
    <div className="p-3 overflow-y-auto h-full">
      <div className="mb-3 space-y-1.5">
        <div className="flex items-center gap-1.5">
          <h2 className="text-sm font-semibold truncate flex-1">{t('dbConnections.title')}</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => void reload()}
            title={t('dbConnections.reload')}
          >
            <RefreshCw className={'h-3.5 w-3.5 ' + (loading ? 'animate-spin' : '')} />
          </Button>
        </div>
        <p className="text-[11px] leading-snug text-muted-foreground">
          {t('dbConnections.description')}
        </p>
      </div>

      {error && (
        <p className="text-[11px] text-destructive mb-2">{t('dbConnections.loadError')}</p>
      )}

      {!error && groups.length === 0 && !loading && (
        <div className="rounded-md border border-dashed p-4 text-center space-y-1">
          <Database className="h-5 w-5 mx-auto text-muted-foreground" />
          <p className="text-xs font-medium">{t('dbConnections.empty')}</p>
          <p className="text-[11px] text-muted-foreground">{t('dbConnections.emptyHint')}</p>
        </div>
      )}

      <div className="space-y-4">
        {groups.map((group) => (
          <section key={group.projectId}>
            <div className="flex items-center gap-1.5 mb-1.5">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground truncate flex-1">
                {group.label}
              </h3>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px] shrink-0"
                onClick={() => navigate(`/projects/${group.projectId}?tab=databases`)}
                title={t('dbConnections.manageHint')}
              >
                <ExternalLink className="h-3 w-3 mr-1" />
                {t('dbConnections.manage')}
              </Button>
            </div>
            <ul className="space-y-1.5">
              {group.rows.map((conn, i) => (
                <li key={`${conn.projectId}:${conn.label}:${i}`} className="rounded-md border p-2">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-medium truncate">{conn.label}</span>
                    <span className={`${badge} bg-muted text-muted-foreground`}>{conn.engine}</span>
                    <span className={`${badge} bg-muted text-muted-foreground`}>
                      {t(`dbConnections.kind.${conn.kind}`, { defaultValue: conn.kind })}
                    </span>
                    {conn.is_read_only && (
                      <span className={`${badge} bg-amber-500/15 text-amber-600 dark:text-amber-400`}>
                        <Lock className="h-2.5 w-2.5" />
                        {t('dbConnections.readOnly')}
                      </span>
                    )}
                  </div>
                  {(conn.host || conn.database) && (
                    <p className="mt-1 text-[11px] text-muted-foreground truncate font-mono">
                      {[conn.host, conn.database].filter(Boolean).join(' · ')}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
