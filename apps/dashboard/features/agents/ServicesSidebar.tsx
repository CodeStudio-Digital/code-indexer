/**
 * ServicesSidebar — lists the secondary microservice containers of a
 * builder session and lets the user add or remove one. Data source is
 * `GET /api/company/sessions/:id/services`; writes go through the
 * orchestrator so the metaBus picks up `sandbox.service.*` events and
 * the live UI stays in sync without a second stream.
 *
 * Stacks list stays hardcoded for now — scaffolder registry is the
 * source of truth at the runtime layer, but exposing it over HTTP is a
 * follow-up. The default choices cover the three we explicitly support
 * in the initial rollout: react-ts (frontend), vue-ts, and a
 * cf-worker/php placeholder that will become live once their
 * scaffolders land.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, RefreshCw, RotateCw, Zap, Pause, Play } from 'lucide-react';
import { Button } from '../../components/ui/button.js';

interface ServiceRow {
  service_id: string;
  name: string;
  stack: string;
  status: string;
  runtime_paused?: boolean;
  step: string;
  host_port: number;
  preview_url: string | null;
  is_primary: boolean;
  error: string | null;
  mount_kind?: 'owned' | 'external';
  image_source?: 'default' | 'project_dockerfile';
  /** Present on orphaned rows so the UI can show where files live. */
  project_id?: number;
  root_path?: string;
  /** True when the service references an externally-managed container. */
  is_attached?: boolean;
  external_container_ref?: string | null;
  attached_hostname?: string | null;
}

interface ServicesSidebarProps {
  sessionId: number;
}

interface ProjectOption {
  id: number;
  name: string;
  root_path: string;
}

interface ProjectManifestResponse {
  manifest: {
    kind: string;
    packageManager?: string;
    devScriptName?: string | null;
    scripts?: Record<string, string>;
  } | null;
  dockerfile: { path: string; exposedPorts: number[] } | null;
}

const KNOWN_STACKS: Array<{ value: string; label: string }> = [
  { value: 'react-ts', label: 'React + Vite (TS)' },
  { value: 'vue-ts', label: 'Vue + Vite (TS)' },
  { value: 'angular', label: 'Angular' },
  { value: 'vite-api', label: 'API — Hono + Vite (TS)' },
  { value: 'cf-worker', label: 'API — Cloudflare Worker (wrangler)' },
];

export default function ServicesSidebar({ sessionId }: ServicesSidebarProps) {
  const { t } = useTranslation('agents');
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restartingId, setRestartingId] = useState<string | null>(null);
  const [runtimePausingId, setRuntimePausingId] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    try {
      const r = await fetch(`/api/company/sessions/${sessionId}/services`);
      if (r.ok) {
        const body = (await r.json()) as { services: ServiceRow[] };
        setServices(body.services ?? []);
        setError(null);
      }
    } catch {
      setError(t('services.errorLoading'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // Poll every 5s while the panel is open so status transitions
    // (provisioning → ready) surface without a dedicated SSE stream.
    const t = setInterval(reload, 5_000);
    return () => clearInterval(t);
  }, [sessionId]);

  async function removeService(serviceId: string, stack: string) {
    const svc = services.find((s) => s.service_id === serviceId);
    const attached = !!svc?.is_attached;
    const external = svc?.mount_kind === 'external';
    const message = attached
      ? t('services.attached.removeConfirm', { serviceId })
      : external
        ? t('services.external.removeConfirm', { serviceId })
        : `Remove microservice '${serviceId}'? The container and its generated files will be destroyed.`;
    if (!confirm(message)) {
      return;
    }
    await fetch(`/api/company/sessions/${sessionId}/services/${encodeURIComponent(serviceId)}`, {
      method: 'DELETE',
    });
    await reload();
  }

  async function restartServiceDev(serviceId: string) {
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

  async function setRuntimePaused(serviceId: string, paused: boolean) {
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

  async function refreshAttachedService(serviceId: string) {
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

  async function startService(serviceId: string, stackOverride?: string) {
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

  async function startOrPromptStack(svc: ServiceRow) {
    if (!svc.is_primary && !svc.stack) {
      const options = KNOWN_STACKS.map((s) => s.value).join(' | ');
      const picked = window.prompt(
        `Stack for '${svc.service_id}'?\nOne of: ${options}`,
        'cf-worker',
      );
      if (!picked?.trim()) return;
      await startService(svc.service_id, picked.trim());
      return;
    }
    await startService(svc.service_id);
  }

  async function retryService(serviceId: string, stackOverride?: string) {
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
  async function retryPrimary() {
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
   * known set before firing the POST. We use a native prompt here —
   * a richer inline dropdown can replace this once the flow sees
   * real use; the prompt is terse enough for the common case.
   */
  async function retryOrphanedService(serviceId: string) {
    const options = KNOWN_STACKS.map((s) => s.value).join(' | ');
    const picked = window.prompt(
      `Stack for '${serviceId}'?\nOne of: ${options}`,
      'cf-worker',
    );
    if (!picked) return;
    const normalized = picked.trim();
    if (!normalized) return;
    await retryService(serviceId, normalized);
  }

  return (
    <div className="px-2.5 py-2 border-t">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
          Microservices
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={reload}
            title="Reload services"
          >
            <RefreshCw className={'h-3 w-3 ' + (loading ? 'animate-spin' : '')} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={() => setAdding(true)}
            title="Add microservice"
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {services.length === 0 && (
        <div className="text-[10px] text-muted-foreground px-1 py-1">
          No services yet. The primary container appears here once the session provisions. Use the + button to add a microservice (e.g. a backend worker or PHP API).
        </div>
      )}

      <div className="space-y-1">
        {services.map((svc) => {
          const isOrphaned = svc.status === 'orphaned';
          const isAttached = !!svc.is_attached;
          const runtimePaused = !!svc.runtime_paused;
          const displayStatus = runtimePaused ? 'paused' : svc.status;
          const isManagedContainer =
            svc.stack !== 'local-process' && !isOrphaned && !isAttached;
          const canPauseRuntime =
            isManagedContainer &&
            (runtimePaused || svc.status === 'ready' || svc.status === 'running');
          const canStart =
            !isAttached &&
            svc.stack !== 'local-process' &&
            (isOrphaned || svc.status === 'paused' || svc.status === 'error');
          const actionBusy =
            runtimePausingId === svc.service_id || startingId === svc.service_id;
          const showPlay = runtimePaused || canStart;
          return (
          <div
            key={svc.service_id}
            className={
              'rounded border p-1.5 flex items-center gap-2 text-[10px] ' +
              (svc.is_primary
                ? 'border-primary/40 bg-primary/5'
                : isOrphaned
                  ? 'border-amber-500/40 bg-amber-500/5'
                  : '')
            }
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1">
                <span className="font-medium truncate">{svc.name || svc.service_id}</span>
                {svc.stack && (
                  <span className="text-muted-foreground text-[9px]">({svc.stack})</span>
                )}
                {svc.is_primary && (
                  <span
                    className="text-[8px] uppercase tracking-wide rounded px-1 bg-primary/15 text-primary"
                    title="Primary container for this session"
                  >
                    main
                  </span>
                )}
                {isOrphaned && !svc.is_primary && (
                  <span
                    className="text-[8px] uppercase tracking-wide rounded px-1 bg-amber-500/15 text-amber-600"
                    title={
                      svc.root_path
                        ? `Container gone. Files still at ${svc.root_path}`
                        : 'Container gone — retry to re-provision.'
                    }
                  >
                    orphaned
                  </span>
                )}
                {svc.mount_kind === 'external' && !isAttached && (
                  <span
                    className="text-[8px] uppercase tracking-wide rounded px-1 bg-sky-500/15 text-sky-600"
                    title="External project files are preserved on delete"
                  >
                    {t('services.external.badge')}
                  </span>
                )}
                {isAttached && (
                  <span
                    className="text-[8px] uppercase tracking-wide rounded px-1 bg-violet-500/15 text-violet-600"
                    title={
                      svc.external_container_ref
                        ? `External container '${svc.external_container_ref}' (managed outside the platform)`
                        : 'Externally-managed container'
                    }
                  >
                    {t('services.attached.badge')}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 text-[9px] text-muted-foreground">
                <span className={statusClassName(displayStatus)}>{displayStatus}</span>
                {svc.preview_url && (
                  <a
                    href={svc.preview_url}
                    target="_blank"
                    rel="noreferrer"
                    className="underline truncate"
                  >
                    open
                  </a>
                )}
              </div>
              {svc.error && (
                <div className="text-[9px] text-red-500 truncate" title={svc.error}>
                  {svc.error}
                </div>
              )}
            </div>
            {isAttached && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={() => void refreshAttachedService(svc.service_id)}
                disabled={refreshingId === svc.service_id}
                title={t('services.attached.refreshTooltip')}
              >
                <RefreshCw
                  className={
                    'h-3 w-3 ' + (refreshingId === svc.service_id ? 'animate-spin' : '')
                  }
                />
              </Button>
            )}
            {!isAttached && (
            <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              onClick={() => {
                if (runtimePaused) {
                  void setRuntimePaused(svc.service_id, false);
                  return;
                }
                if (canStart) {
                  void startOrPromptStack(svc);
                  return;
                }
                void setRuntimePaused(svc.service_id, true);
              }}
              disabled={
                actionBusy ||
                (!canPauseRuntime && !canStart) ||
                svc.status === 'pending' ||
                svc.status === 'provisioning' ||
                svc.status === 'destroying'
              }
              title={
                svc.stack === 'local-process'
                  ? 'Host process cannot be controlled with Podman'
                  : runtimePaused
                    ? 'Unpause container'
                    : canStart
                      ? 'Start container'
                      : isOrphaned
                        ? 'No container to pause'
                        : canPauseRuntime
                          ? 'Pause container'
                          : 'Container is not ready'
              }
            >
              {showPlay ? (
                <Play className={'h-3 w-3 ' + (actionBusy ? 'animate-pulse' : '')} />
              ) : (
                <Pause className={'h-3 w-3 ' + (actionBusy ? 'animate-pulse' : '')} />
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              onClick={() => restartServiceDev(svc.service_id)}
              disabled={restartingId === svc.service_id || svc.is_primary || isOrphaned || runtimePaused}
              title={
                svc.is_primary
                  ? 'Primary dev-server is managed by the session lifecycle'
                  : isOrphaned
                    ? 'No container to restart — use Retry instead'
                    : runtimePaused
                      ? 'Unpause container before restarting dev-server'
                    : 'Restart dev-server (keeps files, relaunches process)'
              }
            >
              <Zap className={'h-3 w-3 ' + (restartingId === svc.service_id ? 'animate-pulse' : '')} />
            </Button>
            <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={() => {
                  if (svc.is_primary) {
                    if (
                      !confirm(
                        `Retry the primary container? The current sandbox will be torn down and rebuilt from the same stack and bind-mount — your files on disk are preserved.`,
                      )
                    ) {
                      return;
                    }
                    void retryPrimary();
                    return;
                  }
                  if (isOrphaned && !svc.stack) {
                    void retryOrphanedService(svc.service_id);
                    return;
                  }
                  void retryService(svc.service_id);
                }}
                title={
                  svc.is_primary
                    ? 'Retry primary container provision (tears down and rebuilds — files kept)'
                    : isOrphaned
                      ? 'Re-provision this service (you will be asked for the stack)'
                      : 'Retry provision'
                }
            >
              <RotateCw className="h-3 w-3" />
            </Button>
            </>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              onClick={() => removeService(svc.service_id, svc.stack)}
              disabled={svc.is_primary}
              title={
                svc.is_primary
                  ? 'Primary container cannot be removed from this panel'
                  : isOrphaned
                      ? svc.mount_kind === 'external'
                        ? 'Drop the orphaned project link; files are preserved'
                        : 'Drop the orphaned project link and delete its files'
                      : 'Remove service'
              }
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
          );
        })}
      </div>

      {adding && (
        <AddServiceForm
          sessionId={sessionId}
          onCancel={() => {
            setAdding(false);
            setError(null);
          }}
          onCreated={async () => {
            setAdding(false);
            setError(null);
            await reload();
          }}
          onError={setError}
        />
      )}
      {error && <div className="text-[10px] text-red-500 px-1 pt-1">{error}</div>}
    </div>
  );
}

function statusClassName(status: string): string {
  switch (status) {
    case 'ready':
    case 'running':
      return 'text-emerald-500';
    case 'paused':
      return 'text-slate-500';
    case 'provisioning':
    case 'pending':
      return 'text-amber-500';
    case 'orphaned':
      return 'text-amber-600';
    case 'error':
      return 'text-red-500';
    default:
      return '';
  }
}

function AddServiceForm({
  sessionId,
  onCancel,
  onCreated,
  onError,
}: {
  sessionId: number;
  onCancel: () => void;
  onCreated: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation('agents');
  const [serviceId, setServiceId] = useState('');
  const [name, setName] = useState('');
  const [stack, setStack] = useState(KNOWN_STACKS[0]!.value);
  const [mode, setMode] = useState<'scaffold' | 'external' | 'attached'>('scaffold');
  const [attachedRef, setAttachedRef] = useState('');
  const [attachedHostname, setAttachedHostname] = useState('');
  const [externalRuntime, setExternalRuntime] = useState<'node' | 'dockerfile'>('node');
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [externalProjectId, setExternalProjectId] = useState('');
  const [externalPath, setExternalPath] = useState('');
  const [manifestInfo, setManifestInfo] = useState<ProjectManifestResponse | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  // Limits default to empty strings — the backend then falls back to
  // the session's primary sandbox limits (builder.limits in config_json)
  // which are in turn the process-wide MCP_SANDBOX_* defaults. Users
  // only touch these fields when they want a service that differs from
  // the company's primary — e.g. a memory-heavy worker next to a light
  // frontend.
  const [memory, setMemory] = useState('');
  const [cpus, setCpus] = useState('');
  const [pids, setPids] = useState('');
  const [primaryLimits, setPrimaryLimits] = useState<{
    memory?: string;
    cpus?: string;
    pids?: number;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showLimits, setShowLimits] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/projects')
      .then((r) => (r.ok ? r.json() : []))
      .then((body: ProjectOption[]) => {
        if (!cancelled) setProjects(body ?? []);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (mode !== 'external' || !externalProjectId) {
      setManifestInfo(null);
      return;
    }
    let cancelled = false;
    setManifestLoading(true);
    fetch(`/api/projects/${externalProjectId}/manifest`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: ProjectManifestResponse | null) => {
        if (!cancelled) {
          setManifestInfo(body);
          if (body?.manifest?.kind === 'node' && body.manifest.devScriptName) {
            setExternalRuntime('node');
          } else if (body?.dockerfile?.exposedPorts?.[0]) {
            setExternalRuntime('dockerfile');
          }
        }
      })
      .catch(() => {
        if (!cancelled) setManifestInfo(null);
      })
      .finally(() => {
        if (!cancelled) setManifestLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, externalProjectId]);

  // Fetch the session's primary builder.limits so we can show them as
  // placeholder hints (the actual inheritance is server-side — this is
  // pure UX).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/company/sessions/${sessionId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { config_json?: string } | null) => {
        if (!body || cancelled) return;
        try {
          const cfg = JSON.parse(body.config_json || '{}') as {
            builder?: { limits?: { memory?: string; cpus?: string; pids?: number } };
          };
          setPrimaryLimits(cfg.builder?.limits ?? {});
        } catch {
          setPrimaryLimits({});
        }
      })
      .catch(() => {
        if (!cancelled) setPrimaryLimits({});
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    onError('');
    try {
      if (mode === 'attached') {
        const containerRef = attachedRef.trim();
        if (!containerRef) {
          onError(t('services.attached.refRequired'));
          return;
        }
        const r = await fetch(`/api/company/sessions/${sessionId}/services/attach`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            service_id: serviceId,
            container_ref: containerRef,
            name: name || undefined,
            hostname: attachedHostname.trim() || undefined,
          }),
        });
        if (!r.ok) {
          const errBody = (await r.json().catch(() => ({}))) as { error?: string };
          onError(errBody.error ?? `HTTP ${r.status}`);
          return;
        }
        await onCreated();
        return;
      }
      const limits: { memory?: string; cpus?: string; pids?: number } = {};
      if (memory.trim()) limits.memory = memory.trim();
      if (cpus.trim()) limits.cpus = cpus.trim();
      if (pids.trim()) {
        const n = Number(pids.trim());
        if (Number.isInteger(n) && n >= 16) limits.pids = n;
      }
      let source: { project_id: number; runtime: 'node' | 'dockerfile' } | undefined;
      if (mode === 'external') {
        let projectId = Number(externalProjectId);
        if (!projectId) {
          const rootPath = externalPath.trim();
          if (!rootPath) {
            onError(t('services.external.pickOrPath'));
            return;
          }
          const nameFromPath =
            rootPath.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() ??
            serviceId;
          const created = await fetch('/api/projects', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: nameFromPath, root_path: rootPath }),
          });
          if (!created.ok) {
            const errBody = (await created.json().catch(() => ({}))) as { error?: string };
            onError(errBody.error ?? t('services.external.createProjectFailed', { status: created.status }));
            return;
          }
          const createdBody = (await created.json()) as { id?: number; project?: { id: number } };
          projectId = createdBody.project?.id ?? createdBody.id ?? 0;
        }
        const manifestRes = await fetch(`/api/projects/${projectId}/manifest`);
        const manifest = manifestRes.ok
          ? ((await manifestRes.json()) as ProjectManifestResponse)
          : null;
        if (externalRuntime === 'node') {
          if (manifest?.manifest?.kind !== 'node' || !manifest.manifest.devScriptName) {
            onError(t('services.external.nodeRuntimeRequired'));
            return;
          }
        } else {
          if (!manifest?.dockerfile?.exposedPorts?.[0]) {
            onError(t('services.external.dockerfileRequired'));
            return;
          }
        }
        source = { project_id: projectId, runtime: externalRuntime };
      }
      const body: Record<string, unknown> = { service_id: serviceId, name, stack };
      if (Object.keys(limits).length > 0) body.limits = limits;
      if (source) body.source = source;
      const r = await fetch(`/api/company/sessions/${sessionId}/services`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const errBody = (await r.json().catch(() => ({}))) as { error?: string };
        onError(errBody.error ?? `HTTP ${r.status}`);
        return;
      }
      await onCreated();
    } finally {
      setSubmitting(false);
    }
  }

  const memoryHint = primaryLimits?.memory ?? 'inherit (1g)';
  const cpusHint = primaryLimits?.cpus ?? 'inherit (1)';
  const pidsHint = primaryLimits?.pids ?? 'inherit (256)';
  const selectedExternalProject = projects.find((p) => String(p.id) === externalProjectId);
  const externalNodeOk =
    mode !== 'external' ||
    !!externalPath.trim() ||
    (manifestInfo?.manifest?.kind === 'node' &&
      !!manifestInfo.manifest.devScriptName &&
      !manifestLoading);
  const externalDockerfileOk =
    mode !== 'external' ||
    !!externalPath.trim() ||
    (!!manifestInfo?.dockerfile?.exposedPorts?.[0] && !manifestLoading);
  const externalRuntimeOk =
    externalRuntime === 'node' ? externalNodeOk : externalDockerfileOk;

  return (
    <form onSubmit={submit} className="mt-2 border rounded p-2 space-y-1.5">
      <div className="grid grid-cols-3 gap-1">
        <button
          type="button"
          className={
            'rounded border px-2 py-1 text-[10px] ' +
            (mode === 'scaffold' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent')
          }
          onClick={() => setMode('scaffold')}
        >
          {t('services.scaffold.title')}
        </button>
        <button
          type="button"
          className={
            'rounded border px-2 py-1 text-[10px] ' +
            (mode === 'external' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent')
          }
          onClick={() => setMode('external')}
        >
          {t('services.external.title')}
        </button>
        <button
          type="button"
          className={
            'rounded border px-2 py-1 text-[10px] ' +
            (mode === 'attached' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent')
          }
          onClick={() => setMode('attached')}
        >
          {t('services.attached.title')}
        </button>
      </div>
      <input
        type="text"
        placeholder="service_id (e.g. api, worker)"
        className="w-full text-[10px] bg-background border rounded px-1.5 py-1"
        value={serviceId}
        onChange={(e) => setServiceId(e.target.value)}
        required
      />
      <input
        type="text"
        placeholder="Display name (optional)"
        className="w-full text-[10px] bg-background border rounded px-1.5 py-1"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      {mode !== 'attached' && (
        <select
          className="w-full text-[10px] bg-background border rounded px-1.5 py-1"
          value={stack}
          onChange={(e) => setStack(e.target.value)}
        >
          {KNOWN_STACKS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      )}

      {mode === 'attached' && (
        <div className="space-y-1 rounded border border-violet-500/40 bg-violet-500/5 p-1.5">
          <input
            type="text"
            placeholder={t('services.attached.refPlaceholder')}
            className="w-full text-[10px] bg-background border rounded px-1.5 py-1 font-mono"
            value={attachedRef}
            onChange={(e) => setAttachedRef(e.target.value)}
            required
          />
          <input
            type="text"
            placeholder={t('services.attached.hostnamePlaceholder')}
            className="w-full text-[10px] bg-background border rounded px-1.5 py-1 font-mono"
            value={attachedHostname}
            onChange={(e) => setAttachedHostname(e.target.value)}
          />
          <div className="text-[9px] text-violet-700 dark:text-violet-300">
            {t('services.attached.notice')}
          </div>
        </div>
      )}

      {mode === 'external' && (
        <div className="space-y-1 rounded border border-amber-500/40 bg-amber-500/5 p-1.5">
          <select
            className="w-full text-[10px] bg-background border rounded px-1.5 py-1"
            value={externalProjectId}
            onChange={(e) => {
              setExternalProjectId(e.target.value);
              if (e.target.value) setExternalPath('');
            }}
          >
            <option value="">{t('services.external.pickProject')}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name} — {project.root_path}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder={t('services.external.pathPlaceholder')}
            className="w-full text-[10px] bg-background border rounded px-1.5 py-1 font-mono"
            value={externalPath}
            onChange={(e) => {
              setExternalPath(e.target.value);
              if (e.target.value.trim()) setExternalProjectId('');
            }}
          />
          <div className="grid grid-cols-2 gap-1">
            <button
              type="button"
              className={
                'rounded border px-2 py-1 text-[10px] ' +
                (externalRuntime === 'node'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-background hover:bg-accent')
              }
              onClick={() => setExternalRuntime('node')}
            >
              {t('services.external.nodeRuntime')}
            </button>
            <button
              type="button"
              className={
                'rounded border px-2 py-1 text-[10px] ' +
                (externalRuntime === 'dockerfile'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-background hover:bg-accent')
              }
              onClick={() => setExternalRuntime('dockerfile')}
            >
              {t('services.external.dockerfileRuntime')}
            </button>
          </div>
          <div className="flex flex-wrap gap-1 text-[9px]">
            <span className="rounded bg-amber-500/15 px-1 py-0.5 text-amber-700 dark:text-amber-300">
              {t('services.external.preserved')}
            </span>
            {selectedExternalProject && (
              <span className="rounded bg-muted px-1 py-0.5 font-mono" title={selectedExternalProject.root_path}>
                {selectedExternalProject.name}
              </span>
            )}
            {manifestLoading && (
              <span className="rounded bg-muted px-1 py-0.5">
                {t('services.external.checking')}
              </span>
            )}
            {manifestInfo?.manifest && (
              <span className="rounded bg-muted px-1 py-0.5">
                {manifestInfo.manifest.kind}
                {manifestInfo.manifest.packageManager
                  ? ` (${manifestInfo.manifest.packageManager})`
                  : ''}
                {manifestInfo.manifest.devScriptName
                  ? ` · ${manifestInfo.manifest.devScriptName}`
                  : ''}
              </span>
            )}
            {externalRuntime === 'node' && !externalNodeOk && externalProjectId && !manifestLoading && (
              <span className="rounded bg-red-500/15 px-1 py-0.5 text-red-600">
                {t('services.external.nodeRuntimeRequired')}
              </span>
            )}
            {manifestInfo?.dockerfile?.exposedPorts?.[0] ? (
              <span className="rounded bg-emerald-500/15 px-1 py-0.5 text-emerald-600">
                {t('services.external.dockerfileDetected', {
                  port: manifestInfo.dockerfile.exposedPorts[0],
                })}
              </span>
            ) : externalRuntime === 'dockerfile' && externalProjectId && !manifestLoading ? (
              <span className="rounded bg-red-500/15 px-1 py-0.5 text-red-600">
                {t('services.external.dockerfileRequired')}
              </span>
            ) : null}
          </div>
        </div>
      )}

      {mode !== 'attached' && (
        <button
          type="button"
          className="text-[10px] text-muted-foreground hover:text-foreground underline"
          onClick={() => setShowLimits((v) => !v)}
        >
          {showLimits ? 'Hide' : 'Override'} container limits
        </button>
      )}
      {mode !== 'attached' && showLimits && (
        <div className="grid grid-cols-3 gap-1">
          <input
            type="text"
            placeholder={`mem ${memoryHint}`}
            className="text-[10px] bg-background border rounded px-1.5 py-1"
            value={memory}
            onChange={(e) => setMemory(e.target.value)}
            title="e.g. 512m, 1g, 2g"
          />
          <input
            type="text"
            placeholder={`cpus ${cpusHint}`}
            className="text-[10px] bg-background border rounded px-1.5 py-1"
            value={cpus}
            onChange={(e) => setCpus(e.target.value)}
            title="e.g. 0.5, 1, 2"
          />
          <input
            type="text"
            placeholder={`pids ${pidsHint}`}
            className="text-[10px] bg-background border rounded px-1.5 py-1"
            value={pids}
            onChange={(e) => setPids(e.target.value)}
            title="integer ≥ 16"
          />
        </div>
      )}
      {mode !== 'attached' && !showLimits && (
        <div className="text-[9px] text-muted-foreground italic">
          Container limits will inherit from the company's primary sandbox.
        </div>
      )}

      <div className="flex items-center gap-1 justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={
            submitting ||
            !serviceId ||
            (mode === 'attached' ? !attachedRef.trim() : !externalRuntimeOk)
          }
        >
          {submitting ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </form>
  );
}
