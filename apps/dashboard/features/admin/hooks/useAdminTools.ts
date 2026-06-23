import { useCallback, useEffect, useState } from 'react';
import { fetchToolConfigs, setToolGlobalDisabled, type ToolConfigItem } from '../tools-api.js';

export function useAdminTools() {
  const [tools, setTools] = useState<ToolConfigItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const items = await fetchToolConfigs();
      setTools(items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = useCallback(async (toolName: string, disabled: boolean) => {
    // Optimistic update
    setTools((prev) =>
      prev.map((t) => (t.name === toolName ? { ...t, globallyDisabled: disabled } : t)),
    );
    try {
      await setToolGlobalDisabled(toolName, disabled);
    } catch {
      // Revert on failure
      setTools((prev) =>
        prev.map((t) => (t.name === toolName ? { ...t, globallyDisabled: !disabled } : t)),
      );
    }
  }, []);

  const filtered = filter
    ? tools.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase()))
    : tools;

  // Dynamically group by tier — supports core tiers + custom tiers from external servers
  const tierOrder = ['bootstrap', 'navigate', 'admin'];
  const allTierNames = [...new Set(tools.map((t) => t.tier))];
  // Sort: core tiers first (in order), then custom tiers alphabetically
  const sortedTiers = [
    ...tierOrder.filter((t) => allTierNames.includes(t)),
    ...allTierNames.filter((t) => !tierOrder.includes(t)).sort(),
  ];

  const byTier: Record<string, ToolConfigItem[]> = {};
  const counts: Record<string, { total: number; enabled: number }> = {};
  for (const tier of sortedTiers) {
    byTier[tier] = filtered.filter((t) => t.tier === tier);
    const allOfTier = tools.filter((t) => t.tier === tier);
    counts[tier] = {
      total: allOfTier.length,
      enabled: allOfTier.filter((t) => !t.globallyDisabled).length,
    };
  }

  return { tools: filtered, byTier, counts, loading, filter, setFilter, toggle, reload: load, sortedTiers };
}
