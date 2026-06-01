/**
 * Top-level Design Systems tab — lists sessions and lets the operator
 * spin up a new one with a zip upload + stack picker.
 *
 * Selecting a session swaps in `DesignSystemSessionView`, mirroring the
 * Agents tab → CompanySessionView flow.
 */
import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Loader2, Palette, Plus, Trash2, RefreshCcw } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import {
  listDesignSystemSessions,
  deleteDesignSystemSession,
  type DesignSystemSessionListEntry,
} from './design-system-api.js';
import { NewDesignSystemDialog } from './NewDesignSystemDialog.js';
import { DesignSystemSessionView } from './DesignSystemSessionView.js';

export function DesignSystemsTab() {
  const { t } = useTranslation('designSystems');
  const [sessions, setSessions] = useState<DesignSystemSessionListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);

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

  if (selectedId !== null) {
    return (
      <DesignSystemSessionView
        sessionId={selectedId}
        onBack={() => { setSelectedId(null); void refresh(); }}
      />
    );
  }

  return (
    <div className="px-3 py-4 sm:px-6 sm:py-6 space-y-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Palette className="h-5 w-5" /> {t('title')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t('description')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCcw className="h-4 w-4 mr-1" /> {t('actions.refresh')}
          </Button>
          <Button size="sm" onClick={() => setShowNew(true)}>
            <Plus className="h-4 w-4 mr-1" /> {t('actions.newSession')}
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
          <Trans i18nKey="sessions.empty" ns="designSystems" components={{ strong: <strong /> }} />
        </div>
      ) : (
        <div className="border rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2">{t('table.name')}</th>
                <th className="text-left px-3 py-2">{t('table.package')}</th>
                <th className="text-left px-3 py-2">{t('table.stack')}</th>
                <th className="text-left px-3 py-2">{t('table.latestVersion')}</th>
                <th className="text-left px-3 py-2">{t('table.status')}</th>
                <th className="text-right px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} className="border-t hover:bg-muted/30">
                  <td className="px-3 py-2 font-medium">
                    <button
                      onClick={() => setSelectedId(s.id)}
                      className="hover:underline text-left"
                    >
                      {s.name}
                    </button>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{s.package_name}</td>
                  <td className="px-3 py-2 text-xs">{s.stack}</td>
                  <td className="px-3 py-2 text-xs">
                    {s.latest_published_semver ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-2 text-xs">{s.company_session_status}</td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        if (!confirm(t('sessions.deleteConfirm', { name: s.name }))) return;
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
          onCreated={(id) => {
            setShowNew(false);
            setSelectedId(id);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
