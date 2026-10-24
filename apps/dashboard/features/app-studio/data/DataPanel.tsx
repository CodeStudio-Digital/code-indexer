/**
 * Painel "Seus dados" do App Studio.
 *
 * A experiencia aqui precisa ser mais proxima de um analista de dados para
 * leigos do que de um cliente SQL cru: resumo, tabelas, relacoes, exemplos e
 * uma consulta SELECT segura para investigacao fina.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  CheckCircle2,
  Columns3,
  Database,
  KeyRound,
  Link2,
  Loader2,
  Lock,
  Play,
  RefreshCcw,
  Rows3,
  Search,
  Table2,
  Wrench,
} from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { cn } from '../../../lib/utils.js';
import type { AppStudioSessionDetail } from '../app-studio-api.js';
import { TableSheetDialog } from './TableSheetDialog.js';
import { type AppDataQueryResult, type AppDataTable, provisionAppData, runAppDataQuery, useAppData } from './useAppData.js';

function dataTabUnlocked(detail: AppStudioSessionDetail | null): boolean {
  return detail != null;
}

function q(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function formatValue(value: unknown): string {
  if (value == null) return '-';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function issueLabel(issue: string, t: (key: string, options?: object) => string): string {
  if (issue === 'no-primary-key') return t('data.issue.noPrimaryKey');
  if (issue === 'empty-table') return t('data.issue.emptyTable');
  if (issue.startsWith('missing-fk:')) return t('data.issue.missingFk', { column: issue.slice('missing-fk:'.length) });
  return issue;
}

export function DataPanel({
  detail,
  onChanged,
}: {
  detail: AppStudioSessionDetail;
  onChanged?: () => void;
}) {
  const { t } = useTranslation('appStudio');
  const unlocked = dataTabUnlocked(detail);
  const { tables, provision, loading, error, refresh } = useAppData(detail.session.id, unlocked);
  const [sheet, setSheet] = useState<{ name: string; label: string } | null>(null);
  const [selectedTableName, setSelectedTableName] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [sql, setSql] = useState('');
  const [queryResult, setQueryResult] = useState<AppDataQueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [provisionError, setProvisionError] = useState<string | null>(null);
  const [provisionMessage, setProvisionMessage] = useState<string | null>(null);
  const [provisionResolved, setProvisionResolved] = useState(false);

  const loadedTables = tables ?? [];
  const provisionKnownClean = provision?.needed === false || provisionResolved;
  const provisionFallbackNeeded = provision === null && !loading && (tables === null || tables.length === 0);
  const needsProvision = provision?.needed === true || (!!error && provision?.needed !== false) || provisionFallbackNeeded;
  const showProvisionAction = !provisionKnownClean && needsProvision;
  const filteredTables = useMemo(() => {
    const term = filter.trim().toLowerCase();
    if (!term) return loadedTables;
    return loadedTables.filter((table) =>
      `${table.label} ${table.name} ${table.columns.map((c) => `${c.label} ${c.name}`).join(' ')}`
        .toLowerCase()
        .includes(term),
    );
  }, [loadedTables, filter]);

  useEffect(() => {
    if (loadedTables.length === 0) {
      setSelectedTableName(null);
      return;
    }
    if (!selectedTableName || !loadedTables.some((table) => table.name === selectedTableName)) {
      setSelectedTableName(loadedTables[0].name);
    }
  }, [loadedTables, selectedTableName]);

  useEffect(() => {
    setProvisionResolved(false);
  }, [detail.session.id]);

  useEffect(() => {
    if (provision?.needed) setProvisionResolved(false);
  }, [provision?.needed]);

  const selectedTable = loadedTables.find((table) => table.name === selectedTableName) ?? filteredTables[0] ?? null;
  const totals = useMemo(() => {
    const relationKeys = new Set<string>();
    for (const table of loadedTables) {
      for (const rel of table.relations_out ?? []) {
        relationKeys.add(`${rel.from_table}.${rel.from_column}->${rel.to_table}.${rel.to_column}`);
      }
    }
    return {
      rows: loadedTables.reduce((sum, table) => sum + table.row_count, 0),
      columns: loadedTables.reduce((sum, table) => sum + table.columns.length, 0),
      relations: relationKeys.size,
      warnings: loadedTables.reduce((sum, table) => sum + (table.health?.issues.length ?? 0), 0),
    };
  }, [loadedTables]);

  useEffect(() => {
    if (!selectedTable) return;
    setQueryResult(null);
    setQueryError(null);
    setSql(`SELECT * FROM ${q(selectedTable.name)} LIMIT 50`);
  }, [selectedTable?.name]);

  async function runQuery() {
    const nextSql = sql.trim();
    if (!nextSql) return;
    setQueryLoading(true);
    setQueryError(null);
    try {
      setQueryResult(await runAppDataQuery(detail.session.id, nextSql));
    } catch (e) {
      setQueryResult(null);
      setQueryError(e instanceof Error ? e.message : String(e));
    } finally {
      setQueryLoading(false);
    }
  }

  async function handleProvision() {
    setProvisioning(true);
    setProvisionError(null);
    setProvisionMessage(null);
    try {
      const result = await provisionAppData(detail.session.id);
      if (result.provision?.needed === false) setProvisionResolved(true);
      setProvisionMessage(
        result.applied.length > 0
          ? t('data.provisionSuccess', { count: result.applied.length })
          : t('data.provisionSuccessNone'),
      );
      refresh();
      onChanged?.();
    } catch (e) {
      setProvisionError(e instanceof Error ? e.message : String(e));
    } finally {
      setProvisioning(false);
    }
  }

  if (!unlocked) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Lock className="h-8 w-8 text-muted-foreground/60" />
        <p className="max-w-xs text-sm text-muted-foreground">{t('data.locked')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <header className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="min-w-[220px] flex-1">
          <h3 className="text-sm font-semibold">{t('data.title')}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('data.subtitle')}</p>
        </div>
        <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-xs" disabled={loading} onClick={refresh}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
          {t('data.refresh')}
        </Button>
      </header>

      {showProvisionAction && (
        <div className="shrink-0 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="min-w-0">
                <p className="font-semibold">{t('data.provisionNeededTitle')}</p>
                <p className="mt-0.5 text-amber-800">{t('data.provisionNeededBody')}</p>
                <p className="mt-1 text-amber-900">{t('data.provisionNeededAction')}</p>
              </div>
            </div>
            <Button
              size="sm"
              className="h-8 shrink-0 gap-1.5 text-xs"
              disabled={provisioning || loading}
              onClick={() => void handleProvision()}
            >
              {provisioning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
              {provisioning ? t('data.provisioning') : t('data.provision')}
            </Button>
          </div>
        </div>
      )}
      {provisionError && (
        <p className="shrink-0 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800">{provisionError}</p>
      )}
      {provisionMessage && (
        <p className="flex shrink-0 items-center gap-1.5 rounded border border-green-300 bg-green-50 p-2 text-xs text-green-800">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {provisionMessage}
        </p>
      )}
      {error && <p className="shrink-0 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800">{error}</p>}

      {tables === null || tables.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center">
          <Database className="h-8 w-8 text-muted-foreground/60" />
          <p className="max-w-xs text-sm text-muted-foreground">
            {showProvisionAction ? t('data.emptyNeedsProvision') : t('data.empty')}
          </p>
        </div>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
            <aside className="flex min-h-0 w-72 shrink-0 flex-col rounded-md border bg-background">
              <div className="shrink-0 border-b p-2">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold">{t('data.tables')}</p>
                    <p className="text-[11px] text-muted-foreground">{t('data.rows', { count: totals.rows })}</p>
                  </div>
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                    {loadedTables.length}
                  </span>
                </div>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    className="h-8 pl-7 text-xs"
                    placeholder={t('data.searchTables')}
                  />
                </div>
                <div className="mt-2 grid grid-cols-2 gap-1.5">
                  <SidebarMetric icon={Columns3} label={t('data.fields')} value={totals.columns} />
                  <SidebarMetric icon={Link2} label={t('data.relations')} value={totals.relations} />
                  <SidebarMetric
                    icon={AlertTriangle}
                    label={t('data.warnings')}
                    value={totals.warnings}
                    tone={totals.warnings > 0 ? 'warning' : 'normal'}
                  />
                  <SidebarMetric icon={Rows3} label={t('data.totalRows')} value={totals.rows} />
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-1.5">
                {filteredTables.length === 0 ? (
                  <p className="p-3 text-xs text-muted-foreground">{t('data.emptySearch')}</p>
                ) : (
                  <div className="space-y-1">
                    {filteredTables.map((table) => {
                      const active = table.name === selectedTable?.name;
                      const issueCount = table.health?.issues.length ?? 0;
                      return (
                        <button
                          key={table.name}
                          type="button"
                          onClick={() => setSelectedTableName(table.name)}
                          className={cn(
                            'w-full rounded-md border px-2.5 py-2 text-left transition-colors',
                            active ? 'border-primary bg-primary/5' : 'border-transparent hover:border-border hover:bg-muted/50',
                          )}
                        >
                          <span className="flex items-center gap-2">
                            <Table2 className="h-3.5 w-3.5 shrink-0 text-primary" />
                            <span className="min-w-0 flex-1 truncate text-xs font-semibold">{table.label}</span>
                            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              {t('data.rows', { count: table.row_count })}
                            </span>
                          </span>
                          <span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">
                            {table.name}
                          </span>
                          <span className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                            <span>{table.columns.length} {t('data.fields')}</span>
                            <span aria-hidden>|</span>
                            <span>{(table.relations_out?.length ?? 0) + (table.relations_in?.length ?? 0)} {t('data.relations')}</span>
                            {issueCount > 0 && (
                              <>
                                <span aria-hidden>|</span>
                                <span className="text-amber-700">{issueCount} {t('data.warnings')}</span>
                              </>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </aside>

            <section className="min-h-0 min-w-0 flex-1 overflow-auto rounded-md border bg-background">
              {selectedTable ? (
                <div className="space-y-3 p-3">
                  <div className="flex flex-wrap items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <h4 className="truncate text-base font-semibold">{selectedTable.label}</h4>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{selectedTable.name}</p>
                    </div>
                    <StatusPill table={selectedTable} />
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 gap-1.5 text-xs"
                      onClick={() => setSheet({ name: selectedTable.name, label: selectedTable.label })}
                    >
                      <Table2 className="h-3.5 w-3.5" />
                      {t('data.asSheet')}
                    </Button>
                  </div>

                  <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_280px]">
                    <div className="rounded-md border">
                      <div className="border-b px-3 py-2 text-xs font-semibold">{t('data.fields')}</div>
                      <div className="divide-y">
                        {selectedTable.columns.map((column) => (
                          <div key={column.name} className="grid gap-2 px-3 py-2 text-xs md:grid-cols-[minmax(0,1fr)_110px_minmax(0,1fr)]">
                            <div className="min-w-0">
                              <p className="truncate font-medium">{column.label}</p>
                              <p className="truncate font-mono text-[11px] text-muted-foreground">{column.name}</p>
                            </div>
                            <div className="flex min-w-0 items-center gap-1">
                              {column.primary_key && <KeyRound className="h-3.5 w-3.5 text-amber-600" />}
                              <span className="truncate rounded bg-muted px-1.5 py-0.5 text-[11px]">{column.type}</span>
                            </div>
                            <div className="min-w-0 text-[11px] text-muted-foreground">
                              <p className="truncate">{column.required ? t('data.required') : t('data.optional')}</p>
                              {column.references && (
                                <p className="mt-0.5 flex min-w-0 items-center gap-1 truncate text-primary">
                                  <Link2 className="h-3 w-3 shrink-0" />
                                  <span className="truncate">{column.references.label}</span>
                                </p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-3">
                      <RelationBox
                        title={t('data.outgoingRelations')}
                        relations={(selectedTable.relations_out ?? []).map((rel) => `${rel.from_column} -> ${rel.to_label}`)}
                      />
                      <RelationBox
                        title={t('data.incomingRelations')}
                        relations={(selectedTable.relations_in ?? []).map((rel) => `${rel.from_label}.${rel.from_column}`)}
                      />
                      {(selectedTable.health?.issues.length ?? 0) > 0 && (
                        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                          <p className="mb-1 font-semibold">{t('data.healthWarning')}</p>
                          <ul className="space-y-1">
                            {selectedTable.health!.issues.map((issue) => (
                              <li key={issue}>{issueLabel(issue, t as never)}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="rounded-md border">
                    <div className="flex items-center justify-between border-b px-3 py-2">
                      <span className="text-xs font-semibold">{t('data.samples')}</span>
                      <span className="text-[11px] text-muted-foreground">{t('data.rows', { count: selectedTable.row_count })}</span>
                    </div>
                    <MiniRows rows={selectedTable.samples} />
                  </div>

                  <div className="rounded-md border">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
                      <div>
                        <p className="text-xs font-semibold">{t('data.queryTitle')}</p>
                        <p className="text-[11px] text-muted-foreground">{t('data.queryReadOnly')}</p>
                      </div>
                      <Button size="sm" className="h-7 gap-1.5 text-xs" disabled={queryLoading || !sql.trim()} onClick={() => void runQuery()}>
                        {queryLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                        {t('data.runQuery')}
                      </Button>
                    </div>
                    <div className="space-y-2 p-3">
                      <textarea
                        value={sql}
                        onChange={(e) => setSql(e.target.value)}
                        className="min-h-[72px] w-full resize-y rounded-md border bg-background p-2 font-mono text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                        placeholder={t('data.queryPlaceholder')}
                      />
                      <div className="flex flex-wrap gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => setSql(`SELECT * FROM ${q(selectedTable.name)} LIMIT 50`)}
                        >
                          {t('data.queryAll')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => setSql(`SELECT COUNT(*) AS total FROM ${q(selectedTable.name)}`)}
                        >
                          {t('data.queryCount')}
                        </Button>
                      </div>
                      {queryError && <p className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800">{queryError}</p>}
                      {queryResult && <QueryResult result={queryResult} />}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex min-h-[280px] items-center justify-center p-6 text-sm text-muted-foreground">
                  {t('data.selectTable')}
                </div>
              )}
            </section>
          </div>
        </>
      )}

      {sheet && (
        <TableSheetDialog
          sessionId={detail.session.id}
          table={sheet.name}
          label={sheet.label}
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  );
}

function SidebarMetric({
  icon: Icon,
  label,
  value,
  tone = 'normal',
}: {
  icon: typeof Table2;
  label: string;
  value: number;
  tone?: 'normal' | 'warning';
}) {
  return (
    <div className={cn('rounded-md border bg-muted/25 px-2 py-1.5', tone === 'warning' && 'border-amber-300 bg-amber-50')}>
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <Icon className={cn('h-3 w-3 shrink-0', tone === 'warning' && 'text-amber-700')} />
        <span className="truncate">{label}</span>
      </div>
      <p className={cn('mt-0.5 text-sm font-semibold leading-5', tone === 'warning' && 'text-amber-900')}>{value}</p>
    </div>
  );
}

function StatusPill({ table }: { table: AppDataTable }) {
  const { t } = useTranslation('appStudio');
  const hasIssues = (table.health?.issues.length ?? 0) > 0;
  return (
    <span
      className={cn(
        'inline-flex h-7 items-center rounded-full px-2 text-[11px] font-medium',
        hasIssues ? 'bg-amber-100 text-amber-800' : 'bg-green-500/10 text-green-700',
      )}
    >
      {hasIssues ? t('data.healthWarning') : t('data.healthOk')}
    </span>
  );
}

function RelationBox({ title, relations }: { title: string; relations: string[] }) {
  const { t } = useTranslation('appStudio');
  return (
    <div className="rounded-md border p-2">
      <p className="mb-1 text-xs font-semibold">{title}</p>
      {relations.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t('data.noRelations')}</p>
      ) : (
        <div className="space-y-1">
          {relations.map((relation) => (
            <p key={relation} className="truncate rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground">
              {relation}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function MiniRows({ rows }: { rows: Array<Record<string, unknown>> }) {
  const { t } = useTranslation('appStudio');
  if (rows.length === 0) return <p className="p-3 text-xs text-muted-foreground">{t('data.noRows')}</p>;
  return (
    <div className="space-y-1 p-3">
      {rows.slice(0, 3).map((row, idx) => (
        <p key={idx} className="truncate rounded bg-muted/60 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
          {Object.entries(row).map(([key, value]) => `${key}: ${formatValue(value)}`).join(' | ')}
        </p>
      ))}
    </div>
  );
}

function QueryResult({ result }: { result: AppDataQueryResult }) {
  const { t } = useTranslation('appStudio');
  return (
    <div className="rounded-md border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2 text-xs">
        <span className="font-semibold">{t('data.result')}</span>
        <span className="text-[11px] text-muted-foreground">
          {t('data.rows', { count: result.row_count })} | {t('data.durationMs', { count: result.duration_ms })}
        </span>
      </div>
      {result.limited && (
        <p className="border-b bg-amber-50 px-3 py-2 text-[11px] text-amber-900">{t('data.limited', { count: result.row_count })}</p>
      )}
      {result.rows.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">{t('data.noRows')}</p>
      ) : (
        <div className="max-h-[320px] overflow-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="sticky top-0 bg-muted">
              <tr>
                {result.columns.map((column) => (
                  <th key={column} className="whitespace-nowrap border-b px-2 py-1.5 font-semibold">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, idx) => (
                <tr key={idx} className="odd:bg-muted/20">
                  {result.columns.map((column) => (
                    <td key={column} className="max-w-[260px] truncate border-b px-2 py-1.5 font-mono text-[11px]">
                      {formatValue(row[column])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
