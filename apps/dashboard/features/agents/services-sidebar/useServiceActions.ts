/**
 * Action handlers + per-action busy state for the services sidebar.
 *
 * Each handler hits a `POST /services/:sid/<action>` endpoint, surfaces
 * any error onto the shared error slot (so the polling hook's failures
 * and these don't drift apart), and triggers a reload so the next 5s
 * poll cycle picks up the new state immediately.
 *
 * Extracted from `ServicesSidebar.tsx` so the sidebar component stays
 * focused on layout decisions, and these handlers can be reused by
 * other future surfaces (per-service drawer, command palette, etc.).
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm, prompt } from '../../../components/ui/prompt-dialog.js';
import { KNOWN_STACKS, type ServiceRow } from './types.js';

interface UseServiceActionsParams {
  sessionId: string;
  services: ServiceRow[];
  reload: () => Promise<void>;
  setError: (msg: string | null) => void;
}

export interface UseServiceActionsResult {
  /** Service id currently being restart-dev'd (Zap button). */
  restartingId: string | null;
  /** Service id currently transitioning to/from runtime-paused. */
  runtimePausingId: string | null;
  /** Service id currently starting (orphan / paused → ready). */
  startingId: string | null;
  /** Attached-service id currently being re-inspected. */
  refreshingId: string | null;

  removeService: (serviceId: string) => Promise<void>;
  restartServiceDev: (serviceId: string) => Promise<void>;
  setRuntimePaused: (serviceId: string, paused: boolean) => Promise<void>;
  refreshAttachedService: (serviceId: string) => Promise<void>;
  startService: (serviceId: string, stackOverride?: string) => Promise<void>;
  /** Service start with stack prompt if the saved row lacks one. */
  startOrPromptStack: (svc: ServiceRow) => Promise<void>;
  /** Retry an existing service row (saved stack/limits/mount preserved). */
  retryService: (serviceId: string, stackOverride?: string) => Promise<void>;
  /** Retry the primary sandbox via `POST /sandbox?retry=1`. */
  retryPrimary: () => Promise<void>;
  /** Retry an orphan with a `window.prompt` for the missing stack. */
  retryOrphanedService: (serviceId: string) => Promise<void>;
  /** B8 — stop the session's host process + drop its persisted row. */
  stopLocalProject: () => Promise<void>;
}

export function useServiceActions({
  sessionId,
  services,
  reload,
  setError,
}: UseServiceActionsParams): UseServiceActionsResult {
  const { t } = useTranslation('agents');
  const [restartingId, setRestartingId] = useState<string | null>(null);
  const [runtimePausingId, setRuntimePausingId] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);

  async function removeService(serviceId: string): Promise<void> {
    const svc = services.find((s) => s.service_id === serviceId);
    const attached = !!svc?.is_attached;
    const external = svc?.mount_kind === 'external';
    const message = attached
      ? t('services.attached.removeConfirm', { serviceId })
      : external
        ? t('services.external.removeConfirm', { serviceId })
        : t('services.removeConfirm', { serviceId });
    if (!(await confirm({
      title: attached
        ? t('services.attached.removeTitle')
        : external
          ? t('services.external.removeTitle')
          : t('services.removeTitle'),
      description: message,
      confirmLabel: t('services.removeAction'),
      tone: 'destructive',
    }))) return;
    await fetch(`/api/company/sessions/${sessionId}/services/${encodeURIComponent(serviceId)}`, {
      method: 'DELETE',
    });
    await reload();
  }

  async function restartServiceDev(serviceId: string): Promise<void> {
    setRestartingId(serviceId);
    setError(null);
    try {
      const r = await fetch(
        `/api/company/sessions/${sessionId}/services/${encodeURIComponent(serviceId)}/restart-dev`,
        { method: 'POST' },
      );
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${r.status}`);
      }
    } finally {
      setRestartingId(null);
    }
    await reload();
  }

  async function setRuntimePaused(serviceId: string, paused: boolean): Promise<void> {
    setRuntimePausingId(serviceId);
    setError(null);
    try {
      const action = paused ? 'pause' : 'unpause';
      const r = await fetch(
        `/api/company/sessions/${sessionId}/services/${encodeURIComponent(serviceId)}/${action}`,
        { method: 'POST' },
      );
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${r.status}`);
      }
    } finally {
      setRuntimePausingId(null);
    }
    await reload();
  }

  async function refreshAttachedService(serviceId: string): Promise<void> {
    setRefreshingId(serviceId);
    setError(null);
    try {
      const r = await fetch(
        `/api/company/sessions/${sessionId}/services/${encodeURIComponent(serviceId)}/refresh`,
        { method: 'POST' },
      );
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${r.status}`);
      }
    } finally {
      setRefreshingId(null);
    }
    await reload();
  }

  async function startService(serviceId: string, stackOverride?: string): Promise<void> {
    setStartingId(serviceId);
    setError(null);
    try {
      const init: RequestInit = { method: 'POST' };
      if (stackOverride) {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify({ stack: stackOverride });
      }
      const r = await fetch(
        `/api/company/sessions/${sessionId}/services/${encodeURIComponent(serviceId)}/start`,
        init,
      );
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${r.status}`);
      }
    } finally {
      setStartingId(null);
    }
    await reload();
  }

  async function startOrPromptStack(svc: ServiceRow): Promise<void> {
    if (!svc.is_primary && !svc.stack) {
      const options = KNOWN_STACKS.map((s) => s.value).join(' | ');
      const picked = await prompt({
        title: `Stack for '${svc.service_id}'`,
        description: `One of: ${options}`,
        defaultValue: 'cf-worker',
        confirmLabel: 'Start',
      });
      if (!picked?.trim()) return;
      await startService(svc.service_id, picked.trim());
      return;
    }
    await startService(svc.service_id);
  }

  async function retryService(serviceId: string, stackOverride?: string): Promise<void> {
    setError(null);
    const init: RequestInit = { method: 'POST' };
    if (stackOverride) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify({ stack: stackOverride });
    }
    const r = await fetch(
      `/api/company/sessions/${sessionId}/services/${encodeURIComponent(serviceId)}/retry`,
      init,
    );
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? `HTTP ${r.status}`);
    }
    await reload();
  }

  /**
   * Retry the PRIMARY sandbox — routes to the session-level endpoint
   * (`POST /sandbox?retry=1`) which knows how to tear down an errored
   * primary and re-provision with the same stack + limits from the
   * session's config_json. The per-service `/retry` path doesn't
   * cover the primary because there's no `company_sandbox_services`
   * row for it (the primary lives in `company_sandboxes`).
   */
  async function retryPrimary(): Promise<void> {
    setError(null);
    const r = await fetch(
      `/api/company/sessions/${sessionId}/sandbox?retry=1`,
      { method: 'POST' },
    );
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? `HTTP ${r.status}`);
    }
    await reload();
  }

  /**
   * Orphaned services lost their row in `company_sandbox_services` so
   * the server has no saved stack to retry with. Pick one from the
   * known set before firing the POST. A richer inline dropdown can
   * replace this once the flow sees real use.
   */
  async function retryOrphanedService(serviceId: string): Promise<void> {
    const options = KNOWN_STACKS.map((s) => s.value).join(' | ');
    const picked = await prompt({
      title: `Stack for '${serviceId}'`,
      description: `One of: ${options}`,
      defaultValue: 'cf-worker',
      confirmLabel: 'Retry',
    });
    if (!picked) return;
    const normalized = picked.trim();
    if (!normalized) return;
    await retryService(serviceId, normalized);
  }

  /**
   * B8 — stop the session's host process. `DELETE /local-project` is the
   * only existing local control route: it SIGTERM→SIGKILLs the child AND
   * hard-deletes the persisted row (there is no restart/pause for host
   * processes in v1).
   */
  async function stopLocalProject(): Promise<void> {
    if (!(await confirm({
      title: t('services.local.stopAction'),
      description: t('services.local.stopConfirm'),
      confirmLabel: t('services.local.stopAction'),
      tone: 'destructive',
    }))) {
      return;
    }
    setError(null);
    const r = await fetch(`/api/company/sessions/${sessionId}/local-project`, {
      method: 'DELETE',
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? `HTTP ${r.status}`);
    }
    await reload();
  }

  return {
    restartingId,
    runtimePausingId,
    startingId,
    refreshingId,
    removeService,
    restartServiceDev,
    setRuntimePaused,
    refreshAttachedService,
    startService,
    startOrPromptStack,
    retryService,
    retryPrimary,
    retryOrphanedService,
    stopLocalProject,
  };
}
