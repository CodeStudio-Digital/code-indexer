import type { Sandbox, SandboxStack, SandboxStatus } from '../../types.js';
import type {
  PersistedSandboxRow,
} from '@mcp/store/company-sandbox-store.js';
import type {
  PersistedSandboxServiceRow,
} from '@mcp/store/company-sandbox-services-store.js';
import { parseLimits } from './persister.js';

/**
 * Build a primary `Sandbox` from a persisted row + a runtime inspect
 * result. Pure — does not touch the registry, allocator, or DB.
 */
export function buildPrimarySandboxFromRow(
  row: PersistedSandboxRow,
  effectiveStatus: SandboxStatus,
  runtimePaused: boolean,
  opts: {
    devServerPort: number;
    buildPreviewUrl: (sessionId: string, hostPort: number) => string;
  },
): Sandbox {
  const previewUrl = opts.buildPreviewUrl(String(row.session_id), row.host_port);
  return {
    id: String(row.session_id),
    containerId: row.container_id,
    runtime: row.runtime,
    stack: row.stack as SandboxStack,
    hostPort: row.host_port,
    workdir: row.workdir,
    containerPort: row.dockerfile_exposed_port ?? opts.devServerPort,
    previewUrl,
    limits: parseLimits(row.limits_json),
    status: effectiveStatus,
    runtimePaused,
    step: effectiveStatus === 'ready' ? 'ready' : 'queued',
    recentLogs: [
      { at: Date.now(), level: 'info', text: `Reclaimed from DB (status=${effectiveStatus})` },
    ],
    createdAt: new Date(row.created_at).getTime() || Date.now(),
    lastAccessAt: row.last_access_at_ms,
    error: row.error ?? undefined,
    hostWorkdirMount: row.host_workdir_mount ?? undefined,
    mountKind: row.mount_kind ?? 'owned',
    imageSource: row.image_source ?? 'default',
    builtImageTag: row.built_image_tag ?? undefined,
    dockerfilePath: row.dockerfile_path ?? undefined,
    dockerfileExposedPort: row.dockerfile_exposed_port ?? undefined,
  };
}

/**
 * Build a secondary-service `Sandbox` from a persisted row. Pure.
 * Mirrors the previewUrl scheme emitted by `provisionAdditionalService`
 * so the `_svc` sentinel in `preview.ts` continues to match.
 */
export function buildServiceSandboxFromRow(
  row: PersistedSandboxServiceRow,
  effectiveStatus: SandboxStatus,
  runtimePaused: boolean,
  opts: { devServerPort: number },
): Sandbox {
  const previewUrl = `/preview/${encodeURIComponent(String(row.session_id))}/_svc/${encodeURIComponent(row.service_id)}/`;
  return {
    id: `${row.session_id}:${row.service_id}`,
    containerId: row.container_id,
    runtime: row.runtime,
    stack: row.stack as SandboxStack,
    hostPort: row.host_port,
    workdir: row.workdir,
    containerPort: row.dockerfile_exposed_port ?? opts.devServerPort,
    previewUrl,
    limits: parseLimits(row.limits_json),
    status: effectiveStatus,
    runtimePaused,
    step: effectiveStatus === 'ready' ? 'ready' : 'queued',
    recentLogs: [
      {
        at: Date.now(),
        level: 'info',
        text: `Reclaimed service from DB (status=${runtimePaused ? 'runtime-paused' : effectiveStatus})`,
      },
    ],
    createdAt: new Date(row.created_at).getTime() || Date.now(),
    lastAccessAt: row.last_access_at_ms,
    error: row.error ?? undefined,
    hostWorkdirMount: row.host_workdir_mount ?? undefined,
    mountKind: row.mount_kind ?? 'owned',
    imageSource: row.image_source ?? 'default',
    builtImageTag: row.built_image_tag ?? undefined,
    dockerfilePath: row.dockerfile_path ?? undefined,
    dockerfileExposedPort: row.dockerfile_exposed_port ?? undefined,
  };
}

/**
 * Build an attached-service `Sandbox` from a persisted row + the result
 * of inspecting the externally-managed container.
 */
export function buildAttachedServiceSandboxFromRow(
  row: PersistedSandboxServiceRow,
  state: {
    status: SandboxStatus;
    runtimePaused: boolean;
    error: string | null;
  },
): Sandbox {
  return {
    id: `${row.session_id}:${row.service_id}`,
    containerId: row.external_container_ref!,
    runtime: row.runtime,
    stack: 'node-only',
    hostPort: 0,
    workdir: '/',
    containerPort: 0,
    previewUrl: '',
    limits: parseLimits(row.limits_json),
    status: state.status,
    runtimePaused: state.runtimePaused,
    step: state.status === 'ready' ? 'ready' : 'queued',
    recentLogs: [
      {
        at: Date.now(),
        level: state.error ? 'error' : 'info',
        text: state.error ?? `Reclaimed attached service (status=${state.status})`,
      },
    ],
    createdAt: new Date(row.created_at).getTime() || Date.now(),
    lastAccessAt: row.last_access_at_ms,
    error: state.error ?? undefined,
    mountKind: 'external',
    imageSource: 'default',
    attached: true,
    externalContainerRef: row.external_container_ref!,
    attachedHostname: row.attached_hostname || row.service_id,
  };
}
