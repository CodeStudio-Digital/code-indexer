/**
 * Filter state + derivation for the Pipelines admin grid.
 *
 * Mirrors the `app-settings/useSettingsFilter` pattern: the hook receives the
 * already-`grouped` catalog (it never re-groups) and returns the subset to
 * render plus facet counts. Counts are computed over the UNFILTERED set so
 * the chips never vanish as the user narrows — same behaviour as the
 * settings sidebar.
 */
import { useMemo, useState } from 'react';
import { norm } from '../../../lib/normalize.js';
import type { PipelineBinding, PipelineCatalogEntry } from '../pipeline-bindings-api.js';
import { type CapabilityBucket, bucketOf } from './capability-meta.js';

export type GroupEntry = [string, { catalog: PipelineCatalogEntry; rows: PipelineBinding[] }];
export type StatusFilter = 'configured' | 'notConfigured' | 'comingSoon';

export interface PipelineFilterState {
  query: string;
  capability: CapabilityBucket | 'all';
  status: StatusFilter | 'all';
  provider: string | 'all';
}

const EMPTY: PipelineFilterState = { query: '', capability: 'all', status: 'all', provider: 'all' };

function statusOf(group: GroupEntry[1]): StatusFilter {
  if (group.catalog.comingSoon) return 'comingSoon';
  return group.rows.some((r) => r.enabled) ? 'configured' : 'notConfigured';
}

function providerNamesOf(group: GroupEntry[1]): string[] {
  return group.rows.map((r) => r.provider_name ?? r.provider_id).filter(Boolean) as string[];
}

export interface PipelineFilterResult {
  state: PipelineFilterState;
  set: <K extends keyof PipelineFilterState>(key: K, value: PipelineFilterState[K]) => void;
  reset: () => void;
  active: boolean;
  visibleGroups: GroupEntry[];
  total: number;
  shown: number;
  capabilityCounts: Record<string, number>;
  statusCounts: Record<StatusFilter, number>;
  providerOptions: string[];
}

export function usePipelineFilter(
  grouped: GroupEntry[],
  getLabelText: (catalog: PipelineCatalogEntry) => string,
): PipelineFilterResult {
  const [state, setState] = useState<PipelineFilterState>(EMPTY);

  const set = <K extends keyof PipelineFilterState>(key: K, value: PipelineFilterState[K]) =>
    setState((s) => ({ ...s, [key]: value }));
  const reset = () => setState(EMPTY);

  // Facet counts + provider options over the UNFILTERED set.
  const { capabilityCounts, statusCounts, providerOptions } = useMemo(() => {
    const cap: Record<string, number> = {};
    const status: Record<StatusFilter, number> = { configured: 0, notConfigured: 0, comingSoon: 0 };
    const providers = new Set<string>();
    for (const [, group] of grouped) {
      const b = bucketOf(group.catalog);
      cap[b] = (cap[b] ?? 0) + 1;
      status[statusOf(group)] += 1;
      for (const p of providerNamesOf(group)) providers.add(p);
    }
    return { capabilityCounts: cap, statusCounts: status, providerOptions: [...providers].sort() };
  }, [grouped]);

  const visibleGroups = useMemo(() => {
    const q = norm(state.query.trim());
    return grouped.filter(([, group]) => {
      if (state.capability !== 'all' && bucketOf(group.catalog) !== state.capability) return false;
      if (state.status !== 'all' && statusOf(group) !== state.status) return false;
      if (state.provider !== 'all' && !providerNamesOf(group).includes(state.provider)) return false;
      if (q) {
        const c = group.catalog;
        const hay = norm(
          [
            getLabelText(c),
            c.pipelineName,
            c.bindingRole,
            c.description,
            c.recommendedDefault?.modelHint ?? '',
            providerNamesOf(group).join(' '),
          ].join(' '),
        );
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [grouped, state, getLabelText]);

  const active = state.query !== '' || state.capability !== 'all' || state.status !== 'all' || state.provider !== 'all';

  return {
    state, set, reset, active,
    visibleGroups,
    total: grouped.length,
    shown: visibleGroups.length,
    capabilityCounts,
    statusCounts,
    providerOptions,
  };
}
