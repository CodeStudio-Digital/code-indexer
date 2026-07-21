import { useEffect, useState } from 'react';
import { useConfirm, useNotify } from '../../../components/ui/dialog-provider.js';
import {
  addProviderModel,
  deleteProvider,
  deleteProviderModel,
  fetchProviderModels,
  fetchProviders,
  refreshProviderModels,
  saveProvider,
  setFallbackProvider as setFallbackProviderApi,
  setModelReasoningLevel,
  setModelContextWindow as setModelContextWindowApi,
  setModelMaxOutputTokens as setModelMaxOutputTokensApi,
  setModelMaxTools as setModelMaxToolsApi,
  backfillContextWindows as backfillContextWindowsApi,
  setSubagentTarget as setSubagentTargetApi,
  setSubagentEffort as setSubagentEffortApi,
  setSubagentLimits as setSubagentLimitsApi,
  testProvider,
  toggleModelEnabled,
} from '../api.js';
import type { AdminModel, AdminProvider, TestResult } from '../types.js';

/**
 * Owns the providers + models + per-row test/refresh state for the Admin
 * page. Wraps the pure fetch helpers in `api.ts` with React state.
 */
export function useAdminProviders() {
  const confirm = useConfirm();
  const notify = useNotify();
  const [providers, setProviders] = useState<AdminProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState<Record<string, AdminModel[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [refreshing, setRefreshing] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setProviders(await fetchProviders());
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const loadModels = async (id: string) => {
    const list = await fetchProviderModels(id);
    setModels((m) => ({ ...m, [id]: list }));
  };

  const save = async (p: Partial<AdminProvider>) => {
    const isExisting = !!providers.find((x) => x.id === p.id);
    try {
      await saveProvider(p, isExisting);
      await load();
    } catch (e) {
      await notify({
        title: 'Save failed',
        description: (e as Error).message,
        variant: 'destructive',
      });
    }
  };

  const remove = async (id: string) => {
    const ok = await confirm({
      title: `Delete provider ${id}?`,
      description: 'This removes the provider and all of its enabled models. The action cannot be undone.',
      variant: 'destructive',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    await deleteProvider(id);
    await load();
  };

  const test = async (id: string) => {
    setTestResults((t) => ({ ...t, [id]: { ok: false, error: 'testing…' } }));
    const result = await testProvider(id);
    setTestResults((t) => ({ ...t, [id]: result }));
  };

  const refresh = async (id: string) => {
    setRefreshing(id);
    try {
      const r = await refreshProviderModels(id);
      if (!r.ok) {
        await notify({
          title: 'Refresh failed',
          description: r.error ?? 'Unknown error',
          variant: 'destructive',
        });
      }
      await loadModels(id);
    } finally {
      setRefreshing(null);
    }
  };

  const toggleModel = async (providerId: string, modelId: string, mode: string, enabled: boolean) => {
    await toggleModelEnabled(providerId, modelId, mode, enabled);
    await loadModels(providerId);
  };

  const addModel = async (
    providerId: string,
    input: { model_id: string; name: string; mode?: string },
  ) => {
    try {
      await addProviderModel(providerId, input);
      await loadModels(providerId);
    } catch (e) {
      await notify({
        title: 'Add model failed',
        description: (e as Error).message,
        variant: 'destructive',
      });
    }
  };

  const deleteModel = async (providerId: string, modelId: string, mode: string) => {
    const ok = await confirm({
      title: `Delete model ${modelId}?`,
      description: 'Removes this manually-added model. The action cannot be undone.',
      variant: 'destructive',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await deleteProviderModel(providerId, modelId, mode);
      await loadModels(providerId);
    } catch (e) {
      await notify({
        title: 'Delete model failed',
        description: (e as Error).message,
        variant: 'destructive',
      });
    }
  };

  const setModelEffort = async (
    providerId: string,
    modelId: string,
    mode: string,
    level: string | null,
  ) => {
    try {
      await setModelReasoningLevel(providerId, modelId, mode, level);
      await loadModels(providerId);
    } catch (e) {
      await notify({
        title: 'Reasoning level update failed',
        description: (e as Error).message,
        variant: 'destructive',
      });
    }
  };

  const setModelContextWindow = async (
    providerId: string,
    modelId: string,
    mode: string,
    value: number | null,
  ) => {
    try {
      await setModelContextWindowApi(providerId, modelId, mode, value);
      await loadModels(providerId);
    } catch (e) {
      await notify({
        title: 'Context window update failed',
        description: (e as Error).message,
        variant: 'destructive',
      });
    }
  };

  const setModelMaxTools = async (
    providerId: string,
    modelId: string,
    mode: string,
    value: number | null,
  ) => {
    try {
      await setModelMaxToolsApi(providerId, modelId, mode, value);
      await loadModels(providerId);
    } catch (e) {
      await notify({
        title: 'Tool cap update failed',
        description: (e as Error).message,
        variant: 'destructive',
      });
    }
  };

  const setModelMaxOutputTokens = async (
    providerId: string,
    modelId: string,
    mode: string,
    value: number | null,
  ) => {
    try {
      await setModelMaxOutputTokensApi(providerId, modelId, mode, value);
      await loadModels(providerId);
    } catch (e) {
      await notify({
        title: 'Output limit update failed',
        description: (e as Error).message,
        variant: 'destructive',
      });
    }
  };

  const backfillContextWindows = async () => {
    try {
      const result = await backfillContextWindowsApi();
      // Refresh whatever provider is expanded so the new values render.
      const providersToRefresh = Object.keys(models);
      await Promise.all(providersToRefresh.map((id) => loadModels(id)));
      await notify({
        title: 'Backfill complete',
        description: `${result.updated} updated, ${result.still_null} still unknown (of ${result.total})`,
        variant: 'success',
      });
    } catch (e) {
      await notify({
        title: 'Context window backfill failed',
        description: (e as Error).message,
        variant: 'destructive',
      });
    }
  };

  const setSubagentTarget = async (
    providerId: string,
    subagentProviderId: string | null,
    modelId: string | null,
    profile?: string,
  ) => {
    try {
      await setSubagentTargetApi(providerId, subagentProviderId, modelId, profile);
      await load();
    } catch (e) {
      await notify({
        title: 'Subagent settings update failed',
        description: (e as Error).message,
        variant: 'destructive',
      });
    }
  };

  const setSubagentEffort = async (
    providerId: string,
    effort: string | null,
    profile?: string,
  ) => {
    try {
      await setSubagentEffortApi(providerId, effort, profile);
      await load();
    } catch (e) {
      await notify({
        title: 'Subagent settings update failed',
        description: (e as Error).message,
        variant: 'destructive',
      });
    }
  };

  const setSubagentLimits = async (
    providerId: string,
    profile: string,
    patch: { maxToolCalls?: number | null; timeoutMs?: number | null },
  ) => {
    try {
      await setSubagentLimitsApi(providerId, profile, patch);
      await load();
    } catch (e) {
      await notify({
        title: 'Subagent settings update failed',
        description: (e as Error).message,
        variant: 'destructive',
      });
    }
  };

  const setFallback = async (providerId: string, fallbackProviderId: string | null) => {
    try {
      await setFallbackProviderApi(providerId, fallbackProviderId);
      await load();
    } catch (e) {
      await notify({
        title: 'Fallback update failed',
        description: (e as Error).message,
        variant: 'destructive',
      });
    }
  };

  return {
    providers,
    loading,
    models,
    expanded,
    setExpanded,
    testResults,
    refreshing,
    load,
    loadModels,
    save,
    remove,
    test,
    refresh,
    toggleModel,
    addModel,
    deleteModel,
    setModelEffort,
    setModelContextWindow,
    setModelMaxOutputTokens,
    setModelMaxTools,
    backfillContextWindows,
    setSubagentTarget,
    setSubagentEffort,
    setSubagentLimits,
    setFallback,
  };
}
