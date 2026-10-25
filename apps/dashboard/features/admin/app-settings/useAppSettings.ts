/**
 * Data + mutation hook for the App Settings panel. Owns fetch/save/restart and
 * the sparse edit buffer. Toast copy is routed through the `settings` i18n
 * namespace. Value resolution is unchanged on the backend — saving PUTs only
 * the touched keys; everything else keeps its db/env/default resolution.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '../../../components/ui/prompt-dialog.js';
import type { EditMap, SettingsResponse } from './types.js';

export function useAppSettings() {
  const { t } = useTranslation('settings');
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<EditMap>({});

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/admin/settings');
      if (!r.ok) throw new Error(`fetch failed (${r.status})`);
      setData((await r.json()) as SettingsResponse);
      setError(null);
      setEdits({});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setEdit = useCallback((key: string, value: string | null) => {
    setEdits((prev) => ({ ...prev, [key]: value }));
  }, []);
  const clearEdit = useCallback((key: string) => {
    setEdits((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const dirtyKeys = Object.keys(edits);
  const dirtyCount = dirtyKeys.length;
  const restartNeeded = !!data?.restartRequired;

  const save = useCallback(async () => {
    if (Object.keys(edits).length === 0) return;
    setSaving(true);
    try {
      const r = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: edits }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string; key?: string };
        throw new Error(body.error === 'invalid_setting'
          ? t('error.invalidSetting', { key: body.key ?? '' })
          : body.error ?? `save failed (${r.status})`);
      }
      const j = (await r.json()) as { restartNeeded?: boolean };
      toast.success(t('toast.saved', { count: Object.keys(edits).length }), {
        description: j.restartNeeded ? t('toast.savedRestart') : t('toast.savedApplied'),
      });
      await reload();
    } catch (e) {
      toast.error(t('toast.saveFailed'), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }, [edits, reload, t]);

  const restart = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/settings/restart', { method: 'POST' });
      if (!r.ok && r.status !== 202) throw new Error(`HTTP ${r.status}`);
      toast.info(t('toast.restarting'), { description: t('toast.restartingDesc') });
    } catch (e) {
      toast.error(t('toast.restartFailed'), { description: e instanceof Error ? e.message : String(e) });
    }
  }, [t]);

  return {
    data, loading, saving, error, edits,
    setEdit, clearEdit, dirtyCount, restartNeeded, reload, save, restart,
  };
}
