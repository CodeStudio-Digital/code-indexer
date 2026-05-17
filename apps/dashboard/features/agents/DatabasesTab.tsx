/**
 * DatabasesTab — session-scoped database registry.
 *
 * Each row of the list represents a typed DB instance (Postgres,
 * MySQL, Supabase, Neon) with a friendly label. The UI reuses
 * `EnvRowEditor` to render the connection-string / API-key env vars
 * so values can be rotated through the same pipeline as any other
 * env var (single source of truth: company_session_envs).
 *
 * Adding a new provider in the future = one entry in the backend
 * `PROVIDERS` registry; this file needs no change.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Plus, RefreshCw, Database, Star, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { EnvRowEditor, type EnvRow } from './EnvRowEditor.js';

type ProviderId = string;

interface ProviderField {
  name: string;
  secret: boolean;
  placeholder?: string;
  label?: string;
}

interface ProviderMetadataField {
  name: string;
  label?: string;
  placeholder?: string;
}

interface ProviderSpec {
  label: string;
  wireProtocol: 'postgres' | 'mysql';
  connectionField: string;
  fields: ProviderField[];
  metadata?: ProviderMetadataField[];
}

interface DatabaseRow {
  id: number;
  label: string;
  provider: ProviderId;
  is_primary: boolean;
  env_keys: Record<string, string>;
  env_values: Record<
    string,
    { key: string; value: string; is_secret: boolean; masked: boolean }
  >;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
}

interface ListResponse {
  databases: DatabaseRow[];
  providers: Record<ProviderId, ProviderSpec>;
}

interface DatabasesTabProps {
  companySessionId: number;
}

export default function DatabasesTab({ companySessionId }: DatabasesTabProps) {
  const { t } = useTranslation('agents');
  const [databases, setDatabases] = useState<DatabaseRow[]>([]);
  const [providers, setProviders] = useState<Record<ProviderId, ProviderSpec>>({});
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  async function reload() {
    setLoading(true);
    try {
      const r = await fetch(
        `/api/company/sessions/${companySessionId}/databases${revealed ? '?reveal=1' : ''}`,
      );
      if (r.ok) {
        const body = (await r.json()) as ListResponse;
        setDatabases(body.databases ?? []);
        setProviders(body.providers ?? {});
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, [companySessionId, revealed]);

  async function promote(dbId: number) {
    const r = await fetch(
      `/api/company/sessions/${companySessionId}/databases/${dbId}/promote`,
      { method: 'POST' },
    );
    if (!r.ok) {
      const b = (await r.json().catch(() => ({}))) as { error?: string };
      setError(b.error ?? `HTTP ${r.status}`);
      return;
    }
    await reload();
  }

  async function remove(dbId: number, label: string) {
    const alsoDelete = confirm(t('databases.confirmDelete1', { label }));
    if (!confirm(t('databases.confirmDelete2', { label }))) return;
    const url = new URL(
      `/api/company/sessions/${companySessionId}/databases/${dbId}`,
      window.location.origin,
    );
    if (alsoDelete) url.searchParams.set('also_delete_envs', '1');
    const r = await fetch(url.toString(), { method: 'DELETE' });
    if (!r.ok) {
      const b = (await r.json().catch(() => ({}))) as { error?: string };
      setError(b.error ?? `HTTP ${r.status}`);
      return;
    }
    await reload();
  }

  return (
    <div className="p-4 overflow-y-auto h-full">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold">{t('databases.title')}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{t('databases.description')}</p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setRevealed((v) => !v)}
            title={revealed ? t('databases.maskSecrets') : t('databases.revealSecrets')}
          >
            {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={reload}
            title={t('databases.reload')}
          >
            <RefreshCw className={'h-3.5 w-3.5 ' + (loading ? 'animate-spin' : '')} />
          </Button>
          <Button type="button" size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-3 w-3 mr-1" /> {t('databases.addDatabase')}
          </Button>
        </div>
      </div>

      {databases.length === 0 ? (
        <div className="text-xs text-muted-foreground border rounded p-3">
          {t('databases.noDatabases')}
        </div>
      ) : (
        <div className="space-y-3">
          {databases.map((db) => (
            <DatabaseCard
              key={db.id}
              db={db}
              spec={providers[db.provider]}
              sessionId={companySessionId}
              onChanged={reload}
              onPromote={() => promote(db.id)}
              onDelete={() => remove(db.id, db.label)}
            />
          ))}
        </div>
      )}

      {error && <div className="mt-2 text-xs text-red-500">{error}</div>}

      {addOpen && (
        <AddDatabaseModal
          sessionId={companySessionId}
          providers={providers}
          existingLabels={new Set(databases.map((d) => d.label))}
          existingPrimaryProviders={
            new Set(databases.filter((d) => d.is_primary).map((d) => d.provider))
          }
          onClose={() => setAddOpen(false)}
          onCreated={async () => {
            setAddOpen(false);
            await reload();
          }}
        />
      )}
    </div>
  );
}

// ─── Card ────────────────────────────────────────────────────────

function DatabaseCard({
  db,
  spec,
  sessionId,
  onChanged,
  onPromote,
  onDelete,
}: {
  db: DatabaseRow;
  spec: ProviderSpec | undefined;
  sessionId: number;
  onChanged: () => Promise<void> | void;
  onPromote: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation('agents');
  if (!spec) return null;
  const envRows: EnvRow[] = spec.fields.map((f) => {
    const v = db.env_values[f.name];
    return {
      key: v?.key ?? f.name,
      value: v?.value ?? '',
      is_secret: f.secret,
      masked: v?.masked ?? f.secret,
      source: 'user',
      updated_at: db.updated_at,
    };
  });
  return (
    <div className="border rounded">
      <div className="px-3 py-2 bg-muted/40 border-b flex items-center gap-2">
        <Database className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold">{db.label}</span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {spec.label}
        </span>
        {db.is_primary && (
          <span className="text-[9px] uppercase tracking-wide text-primary flex items-center gap-0.5">
            <Star className="h-2.5 w-2.5 fill-current" /> {t('databases.primary')}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {!db.is_primary && (
            <Button size="sm" variant="ghost" onClick={onPromote} title={t('databases.promoteToPrimary')}>
              <Star className="h-3 w-3 mr-1" /> {t('databases.promote')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onDelete} title={t('databases.deleteDatabase')}>
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
      <div className="divide-y">
        {envRows.map((row) => (
          <EnvRowEditor
            key={row.key}
            row={row}
            sessionId={sessionId}
            onSaved={onChanged}
            hideDelete
          />
        ))}
      </div>
      {Object.keys(db.metadata).length > 0 && (
        <div className="px-3 py-1.5 text-[10px] text-muted-foreground border-t">
          {Object.entries(db.metadata).map(([k, v]) => (
            <span key={k} className="mr-3">
              <code>{k}</code>: {v}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Add modal ───────────────────────────────────────────────────

function AddDatabaseModal({
  sessionId,
  providers,
  existingLabels,
  existingPrimaryProviders,
  onClose,
  onCreated,
}: {
  sessionId: number;
  providers: Record<ProviderId, ProviderSpec>;
  existingLabels: Set<string>;
  existingPrimaryProviders: Set<ProviderId>;
  onClose: () => void;
  onCreated: () => Promise<void> | void;
}) {
  const { t } = useTranslation('agents');
  const providerIds = Object.keys(providers);
  const [provider, setProvider] = useState<ProviderId>(providerIds[0] ?? '');
  const [label, setLabel] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [metadata, setMetadata] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const spec = providers[provider];
  const willBePrimary = spec ? !existingPrimaryProviders.has(provider) : false;

  function envKeyPreview(fieldName: string): string {
    if (!spec) return fieldName;
    if (willBePrimary) return fieldName;
    const suffix = labelToEnvSuffix(label || 'DB');
    return `${fieldName}_${suffix}`;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!label.trim()) {
      setErr(t('databases.labelRequired'));
      return;
    }
    if (existingLabels.has(label.trim())) {
      setErr(t('databases.labelExists', { label }));
      return;
    }
    if (!spec) {
      setErr(t('databases.pickProvider'));
      return;
    }
    for (const field of spec.fields) {
      if (!values[field.name]) {
        setErr(t('databases.missingField', { field: field.label ?? field.name }));
        return;
      }
    }
    setSubmitting(true);
    try {
      const r = await fetch(`/api/company/sessions/${sessionId}/databases`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          label: label.trim(),
          provider,
          values,
          metadata,
        }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        setErr(b.error ?? `HTTP ${r.status}`);
        return;
      }
      await onCreated();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-background border rounded-lg shadow-xl max-w-xl w-full max-h-[90vh] overflow-auto">
        <div className="p-4 border-b">
          <h3 className="text-sm font-semibold">{t('databases.addDatabaseModalTitle')}</h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">{t('databases.addDatabaseModalDesc')}</p>
        </div>
        <form onSubmit={submit} className="p-4 space-y-4">
          <div>
            <label className="text-xs font-medium block mb-1">{t('databases.provider')}</label>
            <div className="grid grid-cols-2 gap-2">
              {providerIds.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setProvider(id);
                    setValues({});
                    setMetadata({});
                  }}
                  className={
                    'text-left border rounded px-3 py-2 text-xs transition ' +
                    (id === provider
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-muted-foreground')
                  }
                >
                  <div className="font-medium">{providers[id].label}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {providers[id].wireProtocol === 'postgres' ? t('databases.postgresWire') : t('databases.mysqlWire')}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium block mb-1">{t('databases.label')}</label>
            <input
              type="text"
              className="w-full text-xs bg-background border rounded px-2 py-1 font-mono"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="main, analytics, cache-replica…"
              pattern="^[A-Za-z][A-Za-z0-9_-]{0,31}$"
              required
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              {willBePrimary
                ? t('databases.willBePrimary')
                : t('databases.existingPrimary', { provider: spec?.label ?? '' })}
            </p>
          </div>

          {spec && (
            <>
              <div className="space-y-2">
                {spec.fields.map((field) => (
                  <div key={field.name}>
                    <label className="text-xs font-medium block mb-1 flex items-center gap-2">
                      {field.label ?? field.name}
                      {field.secret && (
                        <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                          {t('databases.secret')}
                        </span>
                      )}
                      <span className="ml-auto text-[10px] font-mono text-muted-foreground">
                        → {envKeyPreview(field.name)}
                      </span>
                    </label>
                    <input
                      type={field.secret ? 'password' : 'text'}
                      className="w-full text-xs bg-background border rounded px-2 py-1 font-mono"
                      value={values[field.name] ?? ''}
                      onChange={(e) =>
                        setValues((prev) => ({ ...prev, [field.name]: e.target.value }))
                      }
                      placeholder={field.placeholder}
                      required
                    />
                  </div>
                ))}
              </div>

              {spec.metadata && spec.metadata.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {t('databases.metadata')}
                  </div>
                  {spec.metadata.map((field) => (
                    <div key={field.name}>
                      <label className="text-xs font-medium block mb-1">
                        {field.label ?? field.name}
                      </label>
                      <input
                        type="text"
                        className="w-full text-xs bg-background border rounded px-2 py-1 font-mono"
                        value={metadata[field.name] ?? ''}
                        onChange={(e) =>
                          setMetadata((prev) => ({ ...prev, [field.name]: e.target.value }))
                        }
                        placeholder={field.placeholder}
                      />
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {err && <div className="text-xs text-red-500">{err}</div>}

          <div className="flex items-center gap-2 justify-end pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              {t('databases.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={submitting}>
              {submitting ? t('databases.saving') : t('databases.save')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function labelToEnvSuffix(label: string): string {
  const upper = label.toUpperCase();
  const cleaned = upper.replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : 'DB';
}
