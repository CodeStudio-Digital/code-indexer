import { useCallback, useEffect, useState } from 'react';
import { apiPatch } from '../../../hooks/useApi.js';
import { hydratedReasoningEffort } from '../../chat/execution-mode-state.js';
import type { SessionData } from '../../chat/types.js';
import { DEFAULT_SESSION_MAX_AUTO_CONTINUES } from '@mcp/session-storage/run-limits.js';
interface Defaults {
  initialProvider?: string;
  initialModel?: string;
  initialThinking?: boolean;
  initialReasoningEffort?: string | null;
}
export function useEditorModelSettings(selectedId: string | null, selectedSessionData: SessionData | null, {
  initialProvider, initialModel, initialThinking, initialReasoningEffort,
}: Defaults) {
  const [provider, setProvider] = useState(initialProvider ?? 'zai');
  const [model, setModel] = useState(initialModel ?? '');
  const [maxTurns, setMaxTurns] = useState<number | null>(null);
  const [maxAutoContinues, setMaxAutoContinues] = useState(
    DEFAULT_SESSION_MAX_AUTO_CONTINUES,
  );
  const [temperature, setTemperature] = useState<number | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(initialReasoningEffort ?? null);
  const [planDepth, setPlanDepth] = useState<string | null>(null);
  const [thinking, setThinking] = useState(initialThinking ?? false);
  // Guided surfaces can configure the session before it exists (App Studio's
  // spec specialist launcher). Apply those defaults only while no session is
  // selected; once a session is open, the persisted session row is the source
  // of truth.
  useEffect(() => {
    if (selectedId != null) return;
    if (initialProvider) setProvider(initialProvider);
    if (initialModel !== undefined) setModel(initialModel);
    if (initialThinking !== undefined) setThinking(initialThinking);
    if (initialReasoningEffort !== undefined) setReasoningEffort(initialReasoningEffort ?? null);
  }, [selectedId, initialProvider, initialModel, initialThinking, initialReasoningEffort]);

  // Hydrate the persisted model-settings overrides from the session row so the
  // settings dialog opens reflecting the OPEN session instead of blank defaults
  // (the bug where temperature/effort/plan-depth always reset). Same read
  // pattern AgentChat uses — these values flow through the filesystem session
  // projection. A null turn limit is intentional and means unlimited.
  useEffect(() => {
    const s = selectedSessionData?.session;
    if (!s) return;
    const tmp = (s as { temperature_override?: number | null } | undefined)?.temperature_override;
    setTemperature(typeof tmp === 'number' ? tmp : null);
    const effort = hydratedReasoningEffort(s, selectedId);
    if (effort !== undefined) setReasoningEffort(effort);
    const dep = s?.plan_depth_override;
    setPlanDepth(typeof dep === 'string' && dep.length > 0 ? dep : null);
    setThinking(s.thinking_enabled === true);
    setMaxTurns(
      typeof s.max_turns === 'number' && s.max_turns > 0
        ? s.max_turns
        : null,
    );
    setMaxAutoContinues(
      typeof s.max_auto_continues === 'number' && s.max_auto_continues >= 0
        ? s.max_auto_continues
        : DEFAULT_SESSION_MAX_AUTO_CONTINUES,
    );
  }, [selectedId, selectedSessionData?.session]);

  const handleTemperatureChange = useCallback(async (next: number | null) => {
    setTemperature(next);
    if (!selectedId) return;
    try { await apiPatch(`/coder/sessions/${selectedId}/temperature`, { temperature: next }); } catch { /* optimistic */ }
  }, [selectedId]);

  const handleMaxTurnsChange = useCallback(async (next: number | null) => {
    setMaxTurns(next);
    if (!selectedId) return;
    try {
      await apiPatch(`/coder/sessions/${selectedId}/run-limits`, {
        max_turns: next,
        max_auto_continues: maxAutoContinues,
      });
    } catch { /* optimistic */ }
  }, [maxAutoContinues, selectedId]);

  const handleMaxAutoContinuesChange = useCallback(async (next: number) => {
    setMaxAutoContinues(next);
    if (!selectedId) return;
    try {
      await apiPatch(`/coder/sessions/${selectedId}/run-limits`, {
        max_turns: maxTurns,
        max_auto_continues: next,
      });
    } catch { /* optimistic */ }
  }, [maxTurns, selectedId]);

  const handleReasoningEffortChange = useCallback(async (next: string | null) => {
    setReasoningEffort(next);
    if (!selectedId) return;
    try { await apiPatch(`/coder/sessions/${selectedId}/reasoning-effort`, { effort: next }); } catch { /* optimistic */ }
  }, [selectedId]);

  const handleThinkingChange = useCallback(async (next: boolean) => {
    setThinking(next);
    if (!selectedId) return;
    try { await apiPatch(`/coder/sessions/${selectedId}/thinking`, { thinking: next }); } catch { /* optimistic */ }
  }, [selectedId]);

  const handlePlanDepthChange = useCallback(async (next: string | null) => {
    setPlanDepth(next);
    if (!selectedId) return;
    try { await apiPatch(`/coder/sessions/${selectedId}/plan-depth`, { depth: next }); } catch { /* optimistic */ }
  }, [selectedId]);


  return { provider, setProvider, model, setModel, maxTurns, setMaxTurns, maxAutoContinues, setMaxAutoContinues, temperature, setTemperature, reasoningEffort, setReasoningEffort, planDepth, setPlanDepth, thinking, setThinking, handleTemperatureChange, handleMaxTurnsChange, handleMaxAutoContinuesChange, handleReasoningEffortChange, handleThinkingChange, handlePlanDepthChange };
}
