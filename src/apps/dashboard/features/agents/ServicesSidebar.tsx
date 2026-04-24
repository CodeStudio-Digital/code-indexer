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
import { Plus, Trash2, RefreshCw, RotateCw, Zap, MonitorPlay } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import LocalProjectDialog from './LocalProjectDialog.js';

interface ServiceRow {
  service_id: string;
  name: string;
  stack: string;
  status: string;
  step: string;
  host_port: number;
  preview_url: string | null;
  is_primary: boolean;
  error: string | null;
  /** Present on orphaned rows so the UI can show where files live. */
  project_id?: number;
  root_path?: string;
}

interface ServicesSidebarProps {
  sessionId: number;
}

const KNOWN_STACKS: Array<{ value: string; label: string }> = [
  { value: 'react-ts', label: 'React + Vite (TS)' },
  { value: 'vue-ts', label: 'Vue + Vite (TS)' },
  { value: 'vite-api', label: 'API — Hono + Vite (TS)' },
  { value: 'cf-worker', label: 'API — Cloudflare Worker (wrangler)' },
];

export default function ServicesSidebar({ sessionId }: ServicesSidebarProps) {
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addingLocal, setAddingLocal] = useState(false);
  const [localDialogPrefill, setLocalDialogPrefill] = useState<{
    path: string;
    useAi: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartingId, setRestartingId] = useState<string | null>(null);

  // Retry for local-process orphans: fetch the persisted command so we
  // can pre-fill the dialog, then let the user decide whether to keep
  // the AI toggle (handy if the first attempt picked yarn and failed
  // with ENOENT — they flip it off and retry with the npm fallback).
  async function retryLocalProject() {
    setError(null);
    try {
      const r = await fetch(`/api/company/sessions/${sessionId}/local-project`);
      if (!r.ok) {
        setError(`Could not read persisted command: HTTP ${r.status}`);
        return;
      }
      const body = (await r.json()) as {
        cwd?: string;
        synth_source?: string;
        status?: string;
      };
      if (!body.cwd) {
        setError('No persisted local project to retry — start a new one.');
        return;
      }
      // Delete the orphaned row first so the POST doesn't 409 on the
      // "already running" precondition.
      await fetch(`/api/company/sessions/${sessionId}/local-project`, {
        method: 'DELETE',
      });
      setLocalDialogPrefill({
        path: body.cwd,
        useAi: body.synth_source === 'ai',
      });
      setAddingLocal(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function reload() {
    setLoading(true);
    try {
      const r = await fetch(`/api/company/sessions/${sessionId}/services`);
      if (r.ok) {
        const body = (await r.json()) as { services: ServiceRow[] };
        setServices(body.services ?? []);
      }
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
    // Host-process rows live in a different table and have their own
    // DELETE endpoint. The confirm message is also different — there's
    // no container to destroy, only a running OS process to stop.
    if (stack === 'local-process') {
      if (!confirm(`Stop the local host process for this session?`)) return;
      await fetch(`/api/company/sessions/${sessionId}/local-project`, {
        method: 'DELETE',
      });
      await reload();
      return;
    }
    if (!confirm(`Remove microservice '${serviceId}'? The container and its files will be destroyed.`)) {
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
            onClick={() => setAddingLocal(true)}
            title="Run a local project (host process, not container)"
          >
            <MonitorPlay className="h-3 w-3" />
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
                {svc.stack === 'local-process' && (
                  <span
                    className="text-[8px] uppercase tracking-wide rounded px-1 bg-sky-500/15 text-sky-600"
                    title="Running on the host (not inside Podman)"
                  >
                    host
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 text-[9px] text-muted-foreground">
                <span className={statusClassName(svc.status)}>{svc.status}</span>
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
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              onClick={() => restartServiceDev(svc.service_id)}
              disabled={restartingId === svc.service_id || svc.is_primary || isOrphaned}
              title={
                svc.is_primary
                  ? 'Primary dev-server is managed by the session lifecycle'
                  : isOrphaned
                    ? 'No container to restart — use Retry instead'
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
                  // Host-process retries go through the /local-project
                  // endpoint (not /services/:id/retry, which requires a
                  // primary container). Reopens the dialog pre-filled so
                  // the user can adjust the AI toggle if needed.
                  if (svc.stack === 'local-process') {
                    void retryLocalProject();
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
                  : svc.stack === 'local-process'
                    ? 'Stop the host process'
                    : isOrphaned
                      ? 'Drop the orphaned project link and delete its files'
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
      {addingLocal && (
        <LocalProjectDialog
          sessionId={sessionId}
          initialPath={localDialogPrefill?.path}
          initialUseAi={localDialogPrefill?.useAi}
          onCancel={() => {
            setAddingLocal(false);
            setLocalDialogPrefill(null);
          }}
          onCreated={async () => {
            setAddingLocal(false);
            setLocalDialogPrefill(null);
            await reload();
          }}
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
  const [serviceId, setServiceId] = useState('');
  const [name, setName] = useState('');
  const [stack, setStack] = useState(KNOWN_STACKS[0]!.value);
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
      const limits: { memory?: string; cpus?: string; pids?: number } = {};
      if (memory.trim()) limits.memory = memory.trim();
      if (cpus.trim()) limits.cpus = cpus.trim();
      if (pids.trim()) {
        const n = Number(pids.trim());
        if (Number.isInteger(n) && n >= 16) limits.pids = n;
      }
      const body: Record<string, unknown> = { service_id: serviceId, name, stack };
      if (Object.keys(limits).length > 0) body.limits = limits;
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

  return (
    <form onSubmit={submit} className="mt-2 border rounded p-2 space-y-1.5">
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

      <button
        type="button"
        className="text-[10px] text-muted-foreground hover:text-foreground underline"
        onClick={() => setShowLimits((v) => !v)}
      >
        {showLimits ? 'Hide' : 'Override'} container limits
      </button>
      {showLimits && (
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
      {!showLimits && (
        <div className="text-[9px] text-muted-foreground italic">
          Container limits will inherit from the company's primary sandbox.
        </div>
      )}

      <div className="flex items-center gap-1 justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={submitting || !serviceId}>
          {submitting ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </form>
  );
}
