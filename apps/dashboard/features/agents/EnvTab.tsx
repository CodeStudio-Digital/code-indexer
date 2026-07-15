/**
 * EnvTab — session-scoped environment variables shared by every
 * microservice container. Two-column layout:
 *
 *   - Top: list of current envs grouped by provenance (`auto` from
 *     sandbox/database, `imported` from a `.env` file, `agent` set
 *     by an LLM tool, `user` typed by the operator).
 *   - Bottom: small form to add a new key.
 *
 * All writes go through `PUT/DELETE /api/company/sessions/:id/envs/:key`
 * which immediately syncs `/app/.env` across every running container.
 *
 * Phase 5 stops grouping by hardcoded `PREVIEW_URL_*` / `SERVICE_URL_*`
 * prefix and uses the persisted `source` column instead — DB-managed
 * envs now also surface as `auto`, and the agent's tool writes show
 * up as `agent` so the operator can spot config the LLM injected
 * without grepping the log.
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Plus, RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { confirm } from '../../components/ui/prompt-dialog.js';
import { EnvRowEditor, type EnvAutoKind, type EnvRow, type EnvSource } from './EnvRowEditor.js';
import { EnvScopeSelector, type EnvServiceOption } from './EnvScopeSelector.js';

/** Render order — operator-relevant groups first, system noise last. */
const SOURCE_ORDER: readonly EnvSource[] = ['user', 'agent', 'imported', 'auto'];

const SOURCE_LABELS: Record<EnvSource, string> = {
  user: 'User-defined',
  agent: 'Set by agent',
  imported: 'Imported from .env',
  auto: 'Auto-managed (sandbox + database)',
};

const SOURCE_HINTS: Partial<Record<EnvSource, string>> = {
  auto: 'managed by the sandbox or a database connection — edits may be overwritten',
  agent: 'set by an agent tool — review before relying on the value',
  imported: 'seeded from a .env file on first provision',
};

function bucketEnv(row: EnvRow): EnvSource {
  // Legacy rows can land without a source field — treat them as user-typed.
  return (row.source ?? 'user') as EnvSource;
}

/** Sub-family badge for `auto` rows, derived from the key prefix. */
function autoKindOf(key: string): EnvAutoKind {
  if (key.startsWith('DB_')) return 'database';
  if (
    key.startsWith('SERVICE_URL_') ||
    key.startsWith('PREVIEW_URL_') ||
    key.startsWith('PLAYWRIGHT_')
  ) {
    return 'sandbox';
  }
  return 'auto';
}

/**
 * Session services offered by the scope selector. Includes the primary
 * (the listing synthesizes it as `service_id: 'main'`). Defensive
 * defaults — a session without a sandbox just yields an empty list and
 * the selector collapses to the "all services" chip.
 */
function useSessionServices(sessionId: number): EnvServiceOption[] {
  const [services, setServices] = useState<EnvServiceOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/company/sessions/${sessionId}/services`);
        if (!r.ok) return;
        const body = (await r.json()) as {
          services?: Array<{ service_id?: string; name?: string }>;
        };
        if (cancelled) return;
        setServices(
          (body.services ?? [])
            .filter((s) => !!s.service_id)
            .map((s) => ({ id: s.service_id!, label: s.name || s.service_id! })),
        );
      } catch {
        /* keep last-known list on transient failure */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  return services;
}

interface EnvTabProps {
  companySessionId: number;
}

export default function EnvTab({ companySessionId }: EnvTabProps) {
  const { t } = useTranslation('agents');
  const [envs, setEnvs] = useState<EnvRow[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const services = useSessionServices(companySessionId);

  async function reload() {
    setLoading(true);
    try {
      const r = await fetch(
        `/api/company/sessions/${companySessionId}/envs${revealed ? '?reveal=1' : ''}`,
      );
      if (r.ok) {
        const body = (await r.json()) as { envs: EnvRow[] };
        setEnvs(body.envs ?? []);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, [companySessionId, revealed]);

  async function deleteEnv(key: string) {
    if (!(await confirm({
      title: t('env.confirmDelete', { key }),
      tone: 'destructive',
    }))) {
      return;
    }
    await fetch(`/api/company/sessions/${companySessionId}/envs/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
    await reload();
  }

  return (
    <div className="p-3 overflow-y-auto h-full">
      {/* Header stacks vertically — the sidebar panel is too narrow
          (~280-450px) to fit title+description+actions side by side
          without wrapping the description into 1-2-word ribbons. */}
      <div className="mb-3 space-y-1.5">
        <div className="flex items-center gap-1.5">
          <h2 className="text-sm font-semibold truncate flex-1">{t('env.title')}</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => setRevealed((v) => !v)}
            title={revealed ? t('env.maskSecrets') : t('env.revealSecrets')}
          >
            {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={reload}
            title={t('env.reload')}
          >
            <RefreshCw className={'h-3.5 w-3.5 ' + (loading ? 'animate-spin' : '')} />
          </Button>
        </div>
        <p className="text-[11px] leading-snug text-muted-foreground">
          {t('env.description')}
        </p>
      </div>

      {envs.length === 0 ? (
        <div className="text-xs text-muted-foreground border rounded p-3">
          {t('env.noEnvVars')}
        </div>
      ) : (
        <EnvGroupedList
          envs={envs}
          sessionId={companySessionId}
          services={services}
          onDelete={deleteEnv}
          onReload={reload}
        />
      )}

      <AddEnvForm
        sessionId={companySessionId}
        services={services}
        onSaved={reload}
        onError={setError}
      />
      {error && <div className="mt-2 text-xs text-red-500">{error}</div>}
    </div>
  );
}

function EnvGroupedList({
  envs,
  sessionId,
  services,
  onDelete,
  onReload,
}: {
  envs: EnvRow[];
  sessionId: number;
  services: EnvServiceOption[];
  onDelete: (key: string) => Promise<void>;
  onReload: () => Promise<void>;
}) {
  const groups = useMemo(() => {
    const byBucket = new Map<EnvSource, EnvRow[]>();
    for (const row of envs) {
      const bucket = bucketEnv(row);
      const list = byBucket.get(bucket) ?? [];
      list.push(row);
      byBucket.set(bucket, list);
    }
    return SOURCE_ORDER
      .map((src) => ({ source: src, rows: byBucket.get(src) ?? [] }))
      .filter((g) => g.rows.length > 0);
  }, [envs]);

  return (
    <div className="space-y-3">
      {groups.map(({ source, rows }) => (
        // `auto` is system noise (sandbox/database-managed) — render it
        // collapsed by default so operator-relevant groups own the panel.
        <details key={source} className="border rounded" open={source !== 'auto'}>
          <summary className="cursor-pointer select-none px-3 py-1.5 bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground font-medium border-b flex items-center gap-2">
            <span>{SOURCE_LABELS[source]}</span>
            {SOURCE_HINTS[source] && (
              <span className="normal-case lowercase font-normal text-muted-foreground/80">
                {SOURCE_HINTS[source]}
              </span>
            )}
            <span className="ml-auto normal-case font-normal text-muted-foreground/70">
              {rows.length}
            </span>
          </summary>
          <div className="divide-y">
            {rows.map((row) => (
              <EnvRowEditor
                key={row.key}
                row={row}
                managed={source === 'auto'}
                autoKind={source === 'auto' ? autoKindOf(row.key) : undefined}
                services={services}
                onSaved={onReload}
                onDelete={() => onDelete(row.key)}
                sessionId={sessionId}
              />
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

function AddEnvForm({
  sessionId,
  services,
  onSaved,
  onError,
}: {
  sessionId: number;
  services: EnvServiceOption[];
  onSaved: () => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const { t } = useTranslation('agents');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [isSecret, setIsSecret] = useState(false);
  const [scope, setScope] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    onError(null);
    try {
      const r = await fetch(`/api/company/sessions/${sessionId}/envs/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value, is_secret: isSecret, service_scope: scope }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        onError(b.error ?? `HTTP ${r.status}`);
        return;
      }
      setKey('');
      setValue('');
      setIsSecret(false);
      setScope(null);
      await onSaved();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 border rounded p-3 space-y-2">
      <div className="text-xs font-medium">{t('env.addEnvVar')}</div>
      {/* Vertical stack — the sidebar (~280-450px) was too narrow for
          the prior single-row layout (key `w-56` alone = 224px, then
          value + secret checkbox + button overflowed). Stacking puts
          each input at full width regardless of container size; the
          checkbox + submit share the trailing row. Pattern matches
          VS Code / JetBrains "add env var" panels. */}
      <input
        type="text"
        placeholder={t('env.keyPlaceholder')}
        className="w-full text-xs bg-background border rounded px-2 py-1 font-mono"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        required
        pattern="^[A-Za-z_][A-Za-z0-9_]*$"
        title="Letters, digits, underscore; must not start with a digit"
      />
      <input
        type="text"
        placeholder={t('env.valuePlaceholder')}
        className="w-full text-xs bg-background border rounded px-2 py-1 font-mono"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <EnvScopeSelector services={services} value={scope} onChange={setScope} />
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-1.5 text-xs cursor-pointer">
          <input
            type="checkbox"
            checked={isSecret}
            onChange={(e) => setIsSecret(e.target.checked)}
          />
          <span>{t('env.secret')}</span>
        </label>
        <Button type="submit" size="sm" disabled={submitting || !key}>
          <Plus className="h-3 w-3 mr-1" />
          {submitting ? t('env.saving') : t('env.add')}
        </Button>
      </div>
    </form>
  );
}
