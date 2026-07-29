/**
 * Inline form rendered inside the services sidebar when the user clicks
 * the "+" button. Three modes:
 *
 *   - `scaffold`  — managed container, MCP scaffolder owns the files.
 *   - `external`  — bind-mount an existing project on the host;
 *                   user runtime = `node` (package.json) or `dockerfile`.
 *   - `attached`  — adopt a container the user runs by hand outside
 *                   the platform (just a row binding, no lifecycle).
 *
 * Extracted from `ServicesSidebar.tsx` (Phase 6 — Frente B). Lives
 * alongside the list view as a sibling component, not a child, so it
 * can be lazy-loaded / tested in isolation if needed.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui/button.js';
import {
  KNOWN_STACKS,
  type ProjectManifestResponse,
  type ProjectOption,
} from './types.js';

export interface AddServiceFormProps {
  sessionId: string;
  onCancel: () => void;
  onCreated: () => Promise<void>;
  onError: (msg: string) => void;
}

export function AddServiceForm({ sessionId, onCancel, onCreated, onError }: AddServiceFormProps) {
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
