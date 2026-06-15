/**
 * Per-session composer settings for the editor rail — the same controls the
 * full chat exposes (describe-images, unrestricted tool output, tool
 * permission mode, fallback). Reads the session row / fallback endpoint on
 * select and PATCHes on change (optimistic). Extracted so
 * `useEditorChatSession` stays lean.
 */
import { useCallback, useEffect, useState } from 'react';
import { apiPatch } from '../../../hooks/useApi.js';
import type { SessionData } from '../../chat/types.js';

export function useEditorSessionSettings(selectedId: number | null, sessionData: SessionData | null) {
  // Describe-images is a per-send flag (not persisted), matching AgentChat.
  const [describeImages, setDescribeImages] = useState(false);
  const [unrestrictedOutput, setUnrestrictedOutput] = useState(false);
  const [toolPermissionMode, setToolPermissionMode] = useState<'ask' | 'auto' | 'unrestricted'>('auto');
  const [fallbackProvider, setFallbackProvider] = useState<string | null>(null);
  const [fallbackModel, setFallbackModel] = useState<string | null>(null);

  // Hydrate the persisted toggles from the session row.
  useEffect(() => {
    const s = sessionData?.session;
    setUnrestrictedOutput(!!s?.unrestricted_tool_output);
    setToolPermissionMode(s?.tool_permission_mode ?? 'auto');
  }, [sessionData?.session]);

  // Fallback lives behind its own endpoint.
  useEffect(() => {
    if (!selectedId) {
      setFallbackProvider(null);
      setFallbackModel(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/coder/sessions/${selectedId}/fallback`)
      .then((r) => r.json())
      .then((data: { fallback_provider: string | null; fallback_model: string | null }) => {
        if (cancelled) return;
        setFallbackProvider(data.fallback_provider);
        setFallbackModel(data.fallback_model);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedId]);

  const changeUnrestricted = useCallback(async (next: boolean) => {
    setUnrestrictedOutput(next);
    if (!selectedId) return;
    try { await apiPatch(`/coder/sessions/${selectedId}/unrestricted-output`, { enabled: next }); } catch { /* optimistic */ }
  }, [selectedId]);

  const changePermissionMode = useCallback(async (next: 'ask' | 'auto' | 'unrestricted') => {
    setToolPermissionMode(next);
    if (!selectedId) return;
    try { await apiPatch(`/coder/sessions/${selectedId}/tool-permission-mode`, { mode: next }); } catch { /* optimistic */ }
  }, [selectedId]);

  const changeFallback = useCallback(async (provider: string | null, model: string | null) => {
    setFallbackProvider(provider);
    setFallbackModel(model);
    if (!selectedId) return;
    try {
      await fetch(`/api/coder/sessions/${selectedId}/fallback`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model }),
      });
    } catch { /* optimistic */ }
  }, [selectedId]);

  return {
    describeImages,
    setDescribeImages,
    unrestrictedOutput,
    setUnrestrictedOutput: changeUnrestricted,
    toolPermissionMode,
    setToolPermissionMode: changePermissionMode,
    fallbackProvider,
    fallbackModel,
    onFallbackChange: changeFallback,
  };
}
