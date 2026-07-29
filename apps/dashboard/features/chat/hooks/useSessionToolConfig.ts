import { useCallback, useEffect, useState } from 'react';

export interface SessionToolItem {
  name: string;
  tier: string;
  source: 'native' | 'mcp' | 'mcp_external';
  description: string;
  globallyDisabled: boolean;
  sessionDisabled: boolean;
}

export function useSessionToolConfig(sessionId: string | null) {
  const [tools, setTools] = useState<SessionToolItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/coder/sessions/${sessionId}/tools`);
      const j = (await r.json()) as { tools: SessionToolItem[] };
      setTools(j.tools);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { void load(); }, [load]);

  const toggle = useCallback(async (toolName: string, disabled: boolean) => {
    if (!sessionId) return;
    // Optimistic
    setTools((prev) =>
      prev.map((t) => (t.name === toolName ? { ...t, sessionDisabled: disabled } : t)),
    );
    try {
      await fetch(`/api/coder/sessions/${sessionId}/tools/${encodeURIComponent(toolName)}/disabled`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled }),
      });
    } catch {
      setTools((prev) =>
        prev.map((t) => (t.name === toolName ? { ...t, sessionDisabled: !disabled } : t)),
      );
    }
  }, [sessionId]);

  const copyFrom = useCallback(async (sourceSessionId: string) => {
    if (!sessionId) return;
    await fetch(`/api/coder/sessions/${sessionId}/tools/copy-from/${sourceSessionId}`, {
      method: 'POST',
    });
    await load();
  }, [sessionId, load]);

  const resetAll = useCallback(async () => {
    if (!sessionId) return;
    const disabled = tools.filter((t) => t.sessionDisabled);
    if (disabled.length === 0) return;
    await fetch(`/api/coder/sessions/${sessionId}/tools/bulk-disabled`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tools: disabled.map((t) => ({ name: t.name, disabled: false })) }),
    });
    await load();
  }, [sessionId, tools, load]);

  const filtered = filter
    ? tools.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase()))
    : tools;

  // Dynamically group by tier — supports core tiers + custom tiers from external servers
  const tierOrder = ['bootstrap', 'navigate', 'admin'];
  const allTierNames = [...new Set(tools.map((t) => t.tier))];
  const sortedTiers = [
    ...tierOrder.filter((t) => allTierNames.includes(t)),
    ...allTierNames.filter((t) => !tierOrder.includes(t)).sort(),
  ];

  const byTier: Record<string, SessionToolItem[]> = {};
  for (const tier of sortedTiers) {
    byTier[tier] = filtered.filter((t) => t.tier === tier);
  }

  const activeCount = tools.filter((t) => !t.globallyDisabled && !t.sessionDisabled).length;
  const disabledCount = tools.filter((t) => t.sessionDisabled).length;
  const globalDisabledCount = tools.filter((t) => t.globallyDisabled).length;

  return {
    tools: filtered,
    byTier,
    sortedTiers,
    activeCount,
    disabledCount,
    globalDisabledCount,
    loading,
    filter,
    setFilter,
    toggle,
    copyFrom,
    resetAll,
    reload: load,
  };
}
