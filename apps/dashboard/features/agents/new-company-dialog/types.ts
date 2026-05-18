/**
 * Shared types + the `resolveLimitsFromForm` helper used by both the
 * dialog body and its extracted sub-sections.
 */

export interface Template {
  id: number;
  name: string;
  description: string;
  roles: Array<{ role: string; provider: string; model: string; tier: string; skills?: string[] }>;
}

export interface Project {
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

export type LimitsPreset = 'default' | 'small' | 'medium' | 'large' | 'custom';

export type BuilderStack =
  | 'off'
  | 'react-ts'
  | 'vue-ts'
  | 'angular'
  | 'vite-api'
  | 'cf-worker';

export interface PoolEntry {
  provider: string;
  model: string;
  label?: string;
  notes?: string;
  is_default?: boolean;
}

/**
 * Translate the UI preset into the `builder.limits` payload the server
 * expects (or `null` to mean "use server-side defaults").
 *   - default  → null (respects MCP_SANDBOX_* env)
 *   - small    → 512m / 0.5 CPU / 128 pids
 *   - medium   → 1g   / 1   CPU / 256 pids  (matches factory default)
 *   - large    → 2g   / 2   CPU / 512 pids
 *   - custom   → whatever the three text fields hold
 */
export function resolveLimitsFromForm(
  preset: LimitsPreset,
  memory: string,
  cpus: string,
  pids: string,
): { memory: string; cpus: string; pids: number } | null {
  if (preset === 'default') return null;
  if (preset === 'small') return { memory: '512m', cpus: '0.5', pids: 128 };
  if (preset === 'medium') return { memory: '1g', cpus: '1', pids: 256 };
  if (preset === 'large') return { memory: '2g', cpus: '2', pids: 512 };
  const pidsNum = Number(pids);
  return {
    memory: memory.trim() || '1g',
    cpus: cpus.trim() || '1',
    pids: Number.isFinite(pidsNum) && pidsNum >= 16 ? pidsNum : 256,
  };
}
