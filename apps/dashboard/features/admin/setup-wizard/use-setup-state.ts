/**
 * State machine + data loading for the guided-setup wizard.
 *
 * Loads the user's enabled providers and their enabled models once, then
 * resolves the chosen preset into a per-bucket (provider, model) selection.
 * The selection is fully user-overridable; `canApply` gates the Apply button
 * until every ON bucket has a provider + a model that really exists.
 */
import { useEffect, useMemo, useState } from 'react';
import { fetchProviders, fetchProviderModels } from '../api.js';
import { bulkApplyProfile, type BulkApplyProfileResult } from '../pipeline-bindings-api.js';
import type { CapabilityKind } from '../pipeline-bindings-api.js';
import type { AdminModel, AdminProvider } from '../types.js';
import { type PresetId, pickModel, pickProvider, presetById, providerSupports } from './presets.js';

type SetupStep = 'preset' | 'buckets' | 'review' | 'applying' | 'done';

interface WizardBucket { kind: CapabilityKind; required: boolean }

/** Required = can't be switched off. text_llm is the only hard requirement. */
export const WIZARD_BUCKETS: WizardBucket[] = [
  { kind: 'text_llm', required: true },
  { kind: 'vision', required: false },
  { kind: 'voice', required: false },
  { kind: 'autocomplete', required: false },
];

interface BucketSel { enabled: boolean; providerId: string; modelId: string }

interface SetupState {
  step: SetupStep;
  preset: PresetId;
  buckets: Record<string, BucketSel>;
  error: string | null;
  result: BulkApplyProfileResult | null;
}

export function useSetupState() {
  const [providers, setProviders] = useState<AdminProvider[]>([]);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, AdminModel[]>>({});
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<SetupState>({
    step: 'preset', preset: 'economy', buckets: {}, error: null, result: null,
  });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const all = await fetchProviders();
        const enabled = all.filter((p) => p.enabled && p.has_key);
        const entries = await Promise.all(
          enabled.map(async (p) => [p.id, (await fetchProviderModels(p.id)).filter((m) => m.enabled)] as const),
        );
        if (!alive) return;
        setProviders(enabled);
        setModelsByProvider(Object.fromEntries(entries));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  /** Distinct enabled model ids for a provider. */
  const modelsFor = (providerId: string): AdminModel[] => {
    const seen = new Set<string>();
    return (modelsByProvider[providerId] ?? []).filter((m) => {
      if (seen.has(m.model_id)) return false;
      seen.add(m.model_id);
      return true;
    });
  };

  /** Recompute the per-bucket selection from a preset against what's configured. */
  const choosePreset = (preset: PresetId) => {
    const def = presetById(preset);
    const buckets: Record<string, BucketSel> = {};
    for (const b of WIZARD_BUCKETS) {
      const hint = def.buckets[b.kind];
      const provider = pickProvider(b.kind, hint, providers);
      const modelId = provider ? pickModel(hint, modelsFor(provider.id)) : '';
      // Keep required / preset-on buckets ON even when no provider resolved,
      // so the BucketStep surfaces the "configure a provider" note instead of
      // silently dropping the bucket.
      const on = b.required || def.optionalOn.includes(b.kind);
      buckets[b.kind] = { enabled: on, providerId: provider?.id ?? '', modelId };
    }
    setState((s) => ({ ...s, preset, buckets }));
  };

  // Resolve the default preset once providers have loaded.
  useEffect(() => {
    if (!loading) choosePreset(state.preset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const setBucket = (kind: CapabilityKind, patch: Partial<BucketSel>) =>
    setState((s) => ({ ...s, buckets: { ...s.buckets, [kind]: { ...s.buckets[kind], ...patch } } }));

  const setStep = (step: SetupStep) => setState((s) => ({ ...s, step }));

  /** Providers that can serve a given bucket (already filtered to enabled). */
  const providersFor = (kind: CapabilityKind) => providers.filter((p) => providerSupports(kind, p.kind));

  const activeBuckets = useMemo(
    () => WIZARD_BUCKETS.filter((b) => state.buckets[b.kind]?.enabled),
    [state.buckets],
  );

  const isBucketValid = (kind: CapabilityKind): boolean => {
    const sel = state.buckets[kind];
    if (!sel?.enabled) return true;
    return !!sel.providerId && !!sel.modelId && modelsFor(sel.providerId).some((m) => m.model_id === sel.modelId);
  };

  const canApply = activeBuckets.length > 0 && activeBuckets.every((b) => isBucketValid(b.kind));

  const apply = async () => {
    setState((s) => ({ ...s, step: 'applying', error: null }));
    try {
      const assignments = activeBuckets.map((b) => {
        const sel = state.buckets[b.kind];
        return { capability_kind: b.kind, provider_id: sel.providerId, model_id: sel.modelId };
      });
      const result = await bulkApplyProfile({ assignments });
      setState((s) => ({ ...s, step: 'done', result }));
    } catch (e) {
      setState((s) => ({ ...s, step: 'review', error: (e as Error).message }));
    }
  };

  return {
    loading, providers, state,
    modelsFor, providersFor, choosePreset, setBucket, setStep,
    isBucketValid, canApply, apply,
  };
}

export type SetupController = ReturnType<typeof useSetupState>;
