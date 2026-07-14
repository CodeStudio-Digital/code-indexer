/**
 * "/apps" — o lar do leigo: grade de cards dos apps (status humano +
 * URL quando no ar) + card tracejado "Criar novo app". `?new=1` abre o
 * dialog de criação direto (entrada vinda do New Project wizard).
 * Selecionar um app navega para /apps/:id (AppStudioView).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Globe, Plus, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { confirm } from '../../components/ui/prompt-dialog.js';
import {
  deleteAppStudioSession,
  listAppStudioSessions,
  type AppStudioListEntry,
} from './app-studio-api.js';
import { AppStudioCreateDialog } from './AppStudioCreateDialog.js';

function cardStatus(entry: AppStudioListEntry, t: (k: string, o?: object) => string): { label: string; cls: string } {
  if (entry.live_url) return { label: t('home.status.live'), cls: 'bg-green-500/15 text-green-600' };
  if (!entry.current_phase) return { label: t('home.status.done'), cls: 'bg-green-500/15 text-green-600' };
  if (entry.current_phase_status === 'attention') {
    return { label: t('home.status.review'), cls: 'bg-amber-500/15 text-amber-600' };
  }
  return {
    label: t('home.status.building', { n: entry.phase_done + 1, total: entry.phase_total }),
    cls: 'bg-primary/10 text-primary',
  };
}

export function AppStudioHome() {
  const { t } = useTranslation('appStudio');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessions, setSessions] = useState<AppStudioListEntry[] | null>(null);
  const [creating, setCreating] = useState(() => searchParams.get('new') === '1');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSessions(await listAppStudioSessions());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function openCreate() {
    setCreating(true);
  }
  function closeCreate() {
    setCreating(false);
    if (searchParams.get('new')) {
      searchParams.delete('new');
      setSearchParams(searchParams, { replace: true });
    }
  }

  async function remove(entry: AppStudioListEntry) {
    const go = await confirm({
      title: t('home.delete'),
      description: t('home.deleteConfirm', { name: entry.name }),
      confirmLabel: t('home.delete'),
    });
    if (!go) return;
    await deleteAppStudioSession(entry.id);
    void refresh();
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-5">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Sparkles className="h-5 w-5 text-primary" /> {t('home.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('home.subtitle')}</p>
      </div>
      {error && <p className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800">{error}</p>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <button
          onClick={openCreate}
          className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed text-muted-foreground transition-colors hover:border-primary/60 hover:text-primary"
        >
          <Plus className="h-6 w-6" />
          <span className="text-sm font-medium">{t('home.create')}</span>
        </button>

        {(sessions ?? []).map((entry) => {
          const status = cardStatus(entry, t as never);
          return (
            <div
              key={entry.id}
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/apps/${entry.id}`)}
              onKeyDown={(e) => e.key === 'Enter' && navigate(`/apps/${entry.id}`)}
              className="group flex min-h-32 cursor-pointer flex-col justify-between rounded-lg border bg-card p-4 transition-colors hover:border-primary/50"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 truncate font-medium">{entry.name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void remove(entry);
                  }}
                  className="opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100"
                  title={t('home.delete')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="space-y-1.5">
                <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] ${status.cls}`}>{status.label}</span>
                {entry.live_url && (
                  <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                    <Globe className="h-3 w-3 shrink-0" /> {entry.live_url.replace(/^https?:\/\//, '')}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {sessions !== null && sessions.length === 0 && (
        <p className="text-center text-sm text-muted-foreground">{t('home.empty')}</p>
      )}

      {creating && (
        <AppStudioCreateDialog
          onClose={closeCreate}
          onCreated={(appSessionId, coderSessionId, idea) => {
            closeCreate();
            navigate(`/apps/${appSessionId}`, { state: { coderSessionId, idea } });
          }}
        />
      )}
    </div>
  );
}
