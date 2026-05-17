/**
 * Admin client for the embedded Verdaccio singleton config.
 * Mirrors `chrome-service-api.ts`.
 */
export type VerdaccioStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface VerdaccioState {
  enabled: boolean;
  status: VerdaccioStatus;
  image: string;
  hostPort: number;
  containerId: string | null;
  loopbackUrl: string;
  registryUrl: string;
  lastError: string | null;
  startedAt: string | null;
  maxPatchVersionsPerMinor: number;
  alive?: boolean;
}

async function unwrap<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg: string;
    try {
      const body = await r.json();
      msg = (body as { error?: string }).error ?? r.statusText;
    } catch {
      msg = r.statusText;
    }
    throw new Error(`${r.status}: ${msg}`);
  }
  return (await r.json()) as T;
}

export async function fetchVerdaccio(): Promise<VerdaccioState> {
  return unwrap(await fetch('/api/admin/verdaccio'));
}

export interface VerdaccioPatchInput {
  enabled?: boolean;
  image?: string;
  host_port?: number;
  upstream_token?: string | null;
  max_patch_versions_per_minor?: number;
}

export async function patchVerdaccio(patch: VerdaccioPatchInput): Promise<VerdaccioState> {
  return unwrap(
    await fetch('/api/admin/verdaccio', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  );
}

export async function restartVerdaccio(): Promise<VerdaccioState> {
  return unwrap(await fetch('/api/admin/verdaccio/restart', { method: 'POST' }));
}

export async function testVerdaccio(): Promise<VerdaccioState> {
  return unwrap(await fetch('/api/admin/verdaccio/test', { method: 'POST' }));
}
