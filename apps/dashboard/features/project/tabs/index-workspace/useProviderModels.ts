/**
 * Descoberta de provider/model para o card "Run Index" (extraído da RunsTab).
 * Fonte única: `/api/models` devolve todo modelo conhecido com `provider: kind`.
 * Agrupa por kind no cliente, auto-seleciona o primeiro kind/model válido e
 * mantém `model` coerente com o `kind` escolhido (evita Select em branco).
 */
import { useEffect, useMemo, useState } from 'react';
import type { DiscoveredModel } from './index-run-types.js';

export interface ProviderModels {
  modelsLoading: boolean;
  providerKinds: string[];
  availableModels: DiscoveredModel[];
  kind: string;
  setKind: (k: string) => void;
  model: string;
  setModel: (m: string) => void;
  providerDisabled: boolean;
}

export function useProviderModels(): ProviderModels {
  const [allModels, setAllModels] = useState<DiscoveredModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [kind, setKind] = useState<string>('');
  const [model, setModel] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    setModelsLoading(true);
    fetch('/api/models')
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: unknown) => {
        if (cancelled) return;
        const list: DiscoveredModel[] = Array.isArray(rows)
          ? rows
              .map((m) => {
                if (!m || typeof m !== 'object') return null;
                const o = m as { id?: unknown; name?: unknown; provider?: unknown };
                const id = typeof o.id === 'string' ? o.id : '';
                const provider = typeof o.provider === 'string' ? o.provider : '';
                if (!id || !provider) return null;
                return { id, provider, name: typeof o.name === 'string' ? o.name : id };
              })
              .filter((m): m is DiscoveredModel => m !== null)
          : [];
        setAllModels(list);
      })
      .catch(() => {
        if (!cancelled) setAllModels([]);
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Kinds únicos na ordem em que aparecem (estável).
  const providerKinds = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of allModels) {
      if (!seen.has(m.provider)) {
        seen.add(m.provider);
        out.push(m.provider);
      }
    }
    return out;
  }, [allModels]);

  const availableModels = useMemo(
    () => allModels.filter((m) => m.provider === kind),
    [allModels, kind],
  );

  // Auto-seleciona o primeiro kind quando os modelos chegam.
  useEffect(() => {
    if (!kind && providerKinds.length > 0) setKind(providerKinds[0]);
  }, [providerKinds, kind]);

  // Mantém `model` consistente com o kind selecionado.
  useEffect(() => {
    if (availableModels.length === 0) {
      if (model) setModel('');
      return;
    }
    if (!availableModels.some((m) => m.id === model)) setModel(availableModels[0].id);
  }, [availableModels, model]);

  return {
    modelsLoading,
    providerKinds,
    availableModels,
    kind,
    setKind,
    model,
    setModel,
    providerDisabled: !modelsLoading && providerKinds.length === 0,
  };
}
