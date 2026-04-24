/**
 * EnvTab — session-scoped environment variables shared by every
 * microservice container. Two-column layout:
 *
 *   - Top: list of current envs with inline edit + delete actions.
 *     Secret values render as •••• with a toggle to reveal.
 *   - Bottom: small form to add a new key.
 *
 * All writes go through `PUT/DELETE /api/company/sessions/:id/envs/:key`
 * which immediately syncs `/app/.env` across every running container.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Plus, RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { EnvRowEditor, type EnvRow } from './EnvRowEditor.js';

function isManagedKey(key: string): boolean {
  return key.startsWith('PREVIEW_URL_') || key.startsWith('SERVICE_URL_');
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
    if (!confirm(t('env.confirmDelete', { key }))) {
      return;
    }
    await fetch(`/api/company/sessions/${companySessionId}/envs/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
    await reload();
  }

  return (
    <div className="p-4 overflow-y-auto h-full">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold">{t('env.title')}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{t('env.description')}</p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setRevealed((v) => !v)}
            title={revealed ? t('env.maskSecrets') : t('env.revealSecrets')}
          >
            {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={reload}
            title={t('env.reload')}
          >
            <RefreshCw className={'h-3.5 w-3.5 ' + (loading ? 'animate-spin' : '')} />
          </Button>
        </div>
      </div>

      {envs.length === 0 ? (
        <div className="text-xs text-muted-foreground border rounded p-3">
          {t('env.noEnvVars')}
        </div>
      ) : (
        <div className="space-y-3">
          {envs.some((r) => isManagedKey(r.key)) && (
            <div className="border rounded">
              <div className="px-3 py-1.5 bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground font-medium border-b">
                {t('env.autoServiceUrls')}
                <span className="normal-case lowercase font-normal ml-2">
                  {t('env.autoServiceUrlsHint')}
                </span>
              </div>
              <div className="divide-y">
                {envs
                  .filter((r) => isManagedKey(r.key))
                  .map((row) => (
                    <EnvRowEditor
                      key={row.key}
                      row={row}
                      managed
                      onSaved={reload}
                      onDelete={() => deleteEnv(row.key)}
                      sessionId={companySessionId}
                    />
                  ))}
              </div>
            </div>
          )}
          {envs.some((r) => !isManagedKey(r.key)) && (
            <div className="border rounded">
              <div className="px-3 py-1.5 bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground font-medium border-b">
                {t('env.userDefined')}
              </div>
              <div className="divide-y">
                {envs
                  .filter((r) => !isManagedKey(r.key))
                  .map((row) => (
                    <EnvRowEditor
                      key={row.key}
                      row={row}
                      onSaved={reload}
                      onDelete={() => deleteEnv(row.key)}
                      sessionId={companySessionId}
                    />
                  ))}
              </div>
            </div>
          )}
        </div>
      )}

      <AddEnvForm
        sessionId={companySessionId}
        onSaved={reload}
        onError={setError}
      />
      {error && <div className="mt-2 text-xs text-red-500">{error}</div>}
    </div>
  );
}

function AddEnvForm({
  sessionId,
  onSaved,
  onError,
}: {
  sessionId: number;
  onSaved: () => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const { t } = useTranslation('agents');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [isSecret, setIsSecret] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    onError(null);
    try {
      const r = await fetch(`/api/company/sessions/${sessionId}/envs/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value, is_secret: isSecret }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        onError(b.error ?? `HTTP ${r.status}`);
        return;
      }
      setKey('');
      setValue('');
      setIsSecret(false);
      await onSaved();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 border rounded p-3 space-y-2">
      <div className="text-xs font-medium">{t('env.addEnvVar')}</div>
      <div className="flex gap-2">
        <input
          type="text"
          placeholder={t('env.keyPlaceholder')}
          className="w-56 text-xs bg-background border rounded px-2 py-1 font-mono"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          required
          pattern="^[A-Za-z_][A-Za-z0-9_]*$"
          title="Letters, digits, underscore; must not start with a digit"
        />
        <input
          type="text"
          placeholder={t('env.valuePlaceholder')}
          className="flex-1 text-xs bg-background border rounded px-2 py-1 font-mono"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={isSecret}
            onChange={(e) => setIsSecret(e.target.checked)}
          />
          {t('env.secret')}
        </label>
        <Button type="submit" size="sm" disabled={submitting || !key}>
          <Plus className="h-3 w-3 mr-1" />
          {submitting ? t('env.saving') : t('env.add')}
        </Button>
      </div>
    </form>
  );
}
