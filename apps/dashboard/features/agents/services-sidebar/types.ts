/**
 * Shared types + stack registry + status-color helper for the
 * `services-sidebar/` cluster of components. Pulled out of the original
 * monolithic `ServicesSidebar.tsx` so the list view, add form, and row
 * components can share these without circular imports.
 */

export interface ServiceRow {
  service_id: string;
  /** B8 — 'local' marks a host-process row (`local:<id>`); absent = container. */
  kind?: 'local';
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
  /** Supervisor health verdict (B6): healthy | degraded | down | unknown. */
  health?: string;
  health_detail?: string | null;
  last_health_at_ms?: number | null;
  restart_count?: number;
  /** Epoch-ms the live container was provisioned — uptime anchor. */
  started_at_ms?: number | null;
}

export interface ServicesSidebarProps {
  sessionId: string;
}

export interface ProjectOption {
  id: number;
  name: string;
  root_path: string;
}

export interface ProjectManifestResponse {
  manifest: {
    kind: string;
    packageManager?: string;
    devScriptName?: string | null;
    scripts?: Record<string, string>;
  } | null;
  dockerfile: { path: string; exposedPorts: number[] } | null;
}

/**
 * The user-pickable stacks the Add Service dialog offers. Stays a
 * hardcoded list for now — the scaffolder registry is the source of
 * truth at the runtime layer, but exposing it over HTTP is a follow-up.
 * Keeping the list narrow ensures users only see options whose
 * scaffolders are fully wired today.
 */
export const KNOWN_STACKS: Array<{ value: string; label: string }> = [
  { value: 'react-ts', label: 'React + Vite (TS)' },
  { value: 'vue-ts', label: 'Vue + Vite (TS)' },
  { value: 'angular', label: 'Angular' },
  { value: 'vite-api', label: 'API Node.js' },
  { value: 'cf-worker', label: 'API — Cloudflare Worker (wrangler)' },
];

/** Tailwind bg class for the health badge dot (B6). Unknown/missing → gray. */
export function healthDotClassName(health: string | undefined): string {
  switch (health) {
    case 'healthy':
      return 'bg-emerald-500';
    case 'degraded':
      return 'bg-amber-500';
    case 'down':
      return 'bg-red-500';
    default:
      return 'bg-slate-400';
  }
}

/** Approximate uptime label from the provision timestamp ('' when unknown). */
export function formatUptime(startedAtMs: number | null | undefined, nowMs: number = Date.now()): string {
  if (!startedAtMs || startedAtMs > nowMs) return '';
  const mins = Math.floor((nowMs - startedAtMs) / 60_000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Tailwind color class for the status text. */
export function statusClassName(status: string): string {
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
