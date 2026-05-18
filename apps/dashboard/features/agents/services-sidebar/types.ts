/**
 * Shared types + stack registry + status-color helper for the
 * `services-sidebar/` cluster of components. Pulled out of the original
 * monolithic `ServicesSidebar.tsx` so the list view, add form, and row
 * components can share these without circular imports.
 */

export interface ServiceRow {
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

export interface ServicesSidebarProps {
  sessionId: number;
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
  { value: 'vite-api', label: 'API — Hono + Vite (TS)' },
  { value: 'cf-worker', label: 'API — Cloudflare Worker (wrangler)' },
];

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
