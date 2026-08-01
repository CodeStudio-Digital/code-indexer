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
import { levelFromSession, type OutputCapLevel } from '../../chat/composer/output-cap-levels.js';
import { useSessionExecutionMode } from '../../chat/useSessionExecutionMode.js';

interface EditorSessionSettingsOptions {
  updateSessionData: (fn: (previous: SessionData) => SessionData) => void;
  runnerBusy: boolean;
  refetchSession: () => void;
}

export function useEditorSessionSettings(
  selectedId: string | null,
  sessionData: SessionData | null,
  options: EditorSessionSettingsOptions,
) {
  // Describe-images is a per-send flag (not persisted), matching AgentChat.
  const [describeImages, setDescribeImages] = useState(false);
  const [blockCodeComments, setBlockCodeComments] = useState(true);
  const [outputCapLevel, setOutputCapLevel] = useState<OutputCapLevel>('economic');
  const [toolPermissionMode, setToolPermissionMode] = useState<'ask' | 'auto' | 'unrestricted'>('auto');
  const [fallbackProvider, setFallbackProvider] = useState<string | null>(null);
  const [fallbackModel, setFallbackModel] = useState<string | null>(null);
  const executionModeState = useSessionExecutionMode({
    selectedId,
    sessionData,
    updateSessionData: options.updateSessionData,
    runnerBusy: options.runnerBusy,
    refetchSession: options.refetchSession,
  });

  // Hydrate the persisted toggles from the session row.
  useEffect(() => {
    const s = sessionData?.session;
    if (!s || s.id !== selectedId) {
      setBlockCodeComments(true);
      return;
    }
    setOutputCapLevel(levelFromSession(s));
    setToolPermissionMode(s.tool_permission_mode ?? 'auto');
    setBlockCodeComments(s.block_code_comments !== false);
  }, [selectedId, sessionData?.session]);

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

  const changeOutputCapLevel = useCallback(async (next: OutputCapLevel) => {
    setOutputCapLevel(next);
    if (!selectedId) return;
    try { await apiPatch(`/coder/sessions/${selectedId}/tool-output-cap-level`, { level: next }); } catch { /* optimistic */ }
  }, [selectedId]);

  const changePermissionMode = useCallback(async (next: 'ask' | 'auto' | 'unrestricted') => {
    setToolPermissionMode(next);
    if (!selectedId) return;
    try { await apiPatch(`/coder/sessions/${selectedId}/tool-permission-mode`, { mode: next }); } catch { /* optimistic */ }
  }, [selectedId]);

  const changeBlockCodeComments = useCallback(async (next: boolean) => {
    setBlockCodeComments(next);
    if (!selectedId) return;
    try {
      await apiPatch(`/coder/sessions/${selectedId}/block-code-comments`, { enabled: next });
    } catch { /* optimistic */ }
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
    blockCodeComments,
    setBlockCodeComments: changeBlockCodeComments,
    outputCapLevel,
    setOutputCapLevel: changeOutputCapLevel,
    toolPermissionMode,
    setToolPermissionMode: changePermissionMode,
    fallbackProvider,
    fallbackModel,
    onFallbackChange: changeFallback,
    ...executionModeState,
  };
}
