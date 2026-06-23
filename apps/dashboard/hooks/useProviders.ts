/**
 * Shared hook for fetching enriched provider/model list from the admin-configured
 * provider store. Used by both Chat sessions and Company Agents.
 *
 * Fetches from GET /api/coder/providers. Falls back to static PROVIDERS constant
 * when the server returns `legacy: true`.
 */
import { useEffect, useState } from 'react';
import type { EnrichedProvider, EnrichedProviderModel, ProviderOption } from '../features/chat/types.js';
import { PROVIDERS } from '../features/chat/constants.js';

export interface UseProvidersResult {
  /** Enriched providers from admin panel config. */
  enrichedProviders: EnrichedProvider[];
  /** Flat list suitable for dropdowns. */
  providerOptions: ProviderOption[];
  /** Get models for a specific provider. */
  getModelsForProvider: (providerId: string) => EnrichedProviderModel[];
  /** Get default model for a provider. */
  getDefaultModel: (providerId: string) => string;
  /** Loading state. */
  loading: boolean;
}

export function useProviders(): UseProvidersResult {
  const [enrichedProviders, setEnrichedProviders] = useState<EnrichedProvider[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/coder/providers')
      .then((r) => r.json())
      .then((j: { providers: unknown; legacy?: boolean }) => {
        if (cancelled) return;
        if (!j.legacy && Array.isArray(j.providers) && j.providers.length > 0) {
          setEnrichedProviders(j.providers as EnrichedProvider[]);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const providerOptions: ProviderOption[] =
    enrichedProviders.length > 0
      ? enrichedProviders.map((p) => ({
          id: p.id,
          label: p.name || p.id,
          kind: p.kind,
          models: p.models,
          capabilities: p.capabilities,
        }))
      : PROVIDERS.map((p) => ({
          id: p.id,
          label: p.label,
          models: [{ id: p.defaultModel, name: p.defaultModel, mode: null }],
        }));

  function getModelsForProvider(providerId: string): EnrichedProviderModel[] {
    const provider = enrichedProviders.find((p) => p.id === providerId);
    if (provider) return provider.models;
    const fallback = PROVIDERS.find((p) => p.id === providerId);
    return fallback ? [{ id: fallback.defaultModel, name: fallback.defaultModel, mode: null }] : [];
  }

  function getDefaultModel(providerId: string): string {
    const models = getModelsForProvider(providerId);
    if (models.length > 0) return models[0].id;
    const fallback = PROVIDERS.find((p) => p.id === providerId);
    return fallback?.defaultModel ?? '';
  }

  return { enrichedProviders, providerOptions, getModelsForProvider, getDefaultModel, loading };
}
