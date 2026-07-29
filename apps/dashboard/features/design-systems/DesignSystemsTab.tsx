/**
 * Top-level Design Systems tab — lista as sessões e cria DS Studios novos.
 *
 * Roteia por kind: 'studio' (atual) abre o DsStudioView (chat + preview +
 * rail, tela cheia); 'company' (legado, read-only) abre o
 * DesignSystemSessionView com versões/docs/storybook históricos.
 */
import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Loader2, Palette, Plus, Trash2, RefreshCcw } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { confirm } from '../../components/ui/prompt-dialog.js';
import {
  listDesignSystemSessions,
  deleteDesignSystemSession,
  type DesignSystemSessionListEntry,
  type DsSessionKind,
} from './design-system-api.js';
import { NewDesignSystemDialog } from './NewDesignSystemDialog.js';
import { DesignSystemSessionView } from './DesignSystemSessionView.js';
import { DsStudioView } from './studio/DsStudioView.js';

interface Selected {
  id: string;
  kind: DsSessionKind;
  coderSessionId?: string;
}

export function DesignSystemsTab() {
  const { t } = useTranslation('designSystems');
  const [sessions, setSessions] = useState<DesignSystemSessionListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [selected, setSelected] = useState<Selected | null>(null);

  async function refresh() {
    try {
      const list = await listDesignSystemSessions();
      setSessions(list);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => { void refresh(); }, []);

  if (selected) {
    const back = () => { setSelected(null); void refresh(); };
    if (selected.kind === 'studio') {
      return (
        <DsStudioView
          dsSessionId={selected.id}
          initialCoderSessionId={selected.coderSessionId}
          onBack={back}
        />
      );
    }
    return <DesignSystemSessionView sessionId={selected.id} onBack={back} />;
  }

  return (
    <div className="h-full overflow-auto px-3 py-4 sm:px-6 sm:py-6 space-y-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Palette className="h-5 w-5" /> {t('title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('studio.description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCcw className="h-4 w-4 mr-1" /> {t('actions.refresh')}
          </Button>
          <Button size="sm" onClick={() => setShowNew(true)}>
            <Plus className="h-4 w-4 mr-1" /> {t('studio.new')}
          </Button>
        </div>
      </header>

      {error && (
        <div className="border border-red-300 bg-red-50 text-red-800 text-sm p-3 rounded">
          {error}
        </div>
      )}

      {sessions === null ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t('sessions.loading')}
        </div>
      ) : sessions.length === 0 ? (
        <div className="border border-dashed rounded p-8 text-center text-sm text-muted-foreground">
          <Trans i18nKey="studio.empty" ns="designSystems" components={{ strong: <strong /> }} />
        </div>
      ) : (
        <div className="border rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2">{t('table.name')}</th>
                <th className="text-left px-3 py-2">{t('table.package')}</th>
                <th className="text-left px-3 py-2">{t('table.stack')}</th>
                <th className="text-left px-3 py-2">{t('table.kind')}</th>
                <th className="text-left px-3 py-2">{t('table.latestVersion')}</th>
                <th className="text-right px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} className="border-t hover:bg-muted/30">
                  <td className="px-3 py-2 font-medium">
                    <button
                      onClick={() => setSelected({ id: s.id, kind: s.kind })}
                      className="hover:underline text-left"
                    >
                      {s.name}
                    </button>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{s.package_name}</td>
                  <td className="px-3 py-2 text-xs">{s.stack}</td>
                  <td className="px-3 py-2 text-xs">
                    <KindBadge kind={s.kind} />
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {s.latest_published_semver ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        const key = s.kind === 'studio' ? 'studio.deleteConfirm' : 'sessions.deleteConfirm';
                        if (!(await confirm({
                          title: t(key, { name: s.name }),
                          confirmLabel: t('common:actions.delete'),
                          tone: 'destructive',
                        }))) return;
                        await deleteDesignSystemSession(s.id);
                        await refresh();
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNew && (
        <NewDesignSystemDialog
          onClose={() => setShowNew(false)}
          onCreated={(dsSessionId, coderSessionId) => {
            setShowNew(false);
            setSelected({ id: dsSessionId, kind: 'studio', coderSessionId });
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function KindBadge({ kind }: { kind: DsSessionKind }) {
  const { t } = useTranslation('designSystems');
  if (kind === 'studio') {
    return (
      <span className="inline-flex rounded border border-indigo-300 bg-indigo-50 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-indigo-800">
        {t('kind.studio')}
      </span>
    );
  }
  return (
    <span className="inline-flex rounded border border-zinc-300 bg-zinc-50 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-700">
      {t('kind.legacy')}
    </span>
  );
}
