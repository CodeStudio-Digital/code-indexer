import type { AdminModel, AdminProvider, TestResult, ProviderConfigDescriptor } from './types.js';

export async function fetchProviders(): Promise<AdminProvider[]> {
  const r = await fetch('/api/admin/providers');
  const j = (await r.json()) as { providers: AdminProvider[] };
  return j.providers;
}

/** A provider SHAPE known to the registry — built-ins AND enabled plugins. */
export interface KnownProvider {
  kind: string;
  displayName: string;
  credKind: string;
  visual: { icon: string; fg: string; bg: string } | null;
  /** Declarative settings-form fields (extras beyond api_key/base_url). */
  config?: ProviderConfigDescriptor | null;
}

/**
 * The registry of known provider shapes (drives the "Add provider" kind picker).
 * Includes providers contributed by enabled plugins, so a declarative plugin
 * provider is configurable exactly like a built-in.
 */
export async function fetchKnownProviders(): Promise<KnownProvider[]> {
  const r = await fetch('/api/admin/providers/known');
  if (!r.ok) return [];
  return (await r.json()) as KnownProvider[];
}

export async function fetchProviderModels(id: string): Promise<AdminModel[]> {
  const r = await fetch(`/api/admin/providers/${id}/models`);
  const j = (await r.json()) as { models: AdminModel[] };
  return j.models;
}

export async function saveProvider(p: Partial<AdminProvider>, isExisting: boolean): Promise<void> {
  const method = isExisting ? 'PATCH' : 'POST';
  const url = isExisting ? `/api/admin/providers/${p.id}` : '/api/admin/providers';
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  });
  if (!r.ok) {
    const err = (await r.json()) as { error: string };
    throw new Error(err.error);
  }
}

export async function deleteProvider(id: string): Promise<void> {
  await fetch(`/api/admin/providers/${id}`, { method: 'DELETE' });
}

/** Delete a manually-added model. Only `source='manual'` rows are removable. */
export async function deleteProviderModel(
  providerId: string,
  modelId: string,
  mode: string,
): Promise<void> {
  const r = await fetch(
    `/api/admin/providers/${providerId}/models/${encodeURIComponent(modelId)}?mode=${encodeURIComponent(mode)}`,
    { method: 'DELETE' },
  );
  if (!r.ok) {
    const err = (await r.json().catch(() => ({ error: r.statusText }))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${r.status}`);
  }
}

export async function testProvider(id: string): Promise<TestResult> {
  const r = await fetch(`/api/admin/providers/${id}/test`, { method: 'POST' });
  return (await r.json()) as TestResult;
}

export async function refreshProviderModels(
  id: string,
): Promise<{ ok: boolean; count?: number; error?: string }> {
  const r = await fetch(`/api/admin/providers/${id}/models/refresh`, { method: 'POST' });
  return (await r.json()) as { ok: boolean; count?: number; error?: string };
}

/**
 * Manually add a model to a provider (free-text model id). The backend tags
 * it `source='manual'` so a subsequent live refresh won't wipe it. Used for
 * experimental models that live discovery doesn't return yet.
 */
export async function addProviderModel(
  id: string,
  input: { model_id: string; name: string; mode?: string },
): Promise<void> {
  const r = await fetch(`/api/admin/providers/${id}/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({ error: r.statusText }))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${r.status}`);
  }
}

export async function setFallbackProvider(
  providerId: string,
  fallbackProviderId: string | null,
): Promise<void> {
  const r = await fetch(`/api/admin/providers/${providerId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fallback_provider_id: fallbackProviderId }),
  });
  if (!r.ok) {
    const err = (await r.json()) as { error: string };
    throw new Error(err.error);
  }
}

export async function toggleModelEnabled(
  providerId: string,
  modelId: string,
  mode: string,
  enabled: boolean,
): Promise<void> {
  await fetch(
    `/api/admin/providers/${providerId}/models/${encodeURIComponent(modelId)}?mode=${encodeURIComponent(mode)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    },
  );
}

export async function setSubagentTarget(
  providerId: string,
  subagentProviderId: string | null,
  modelId: string | null,
): Promise<void> {
  const r = await fetch(`/api/admin/providers/${providerId}/subagent-model`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider_id: subagentProviderId, model_id: modelId }),
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({ error: r.statusText }))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${r.status}`);
  }
}

export async function setModelReasoningLevel(
  providerId: string,
  modelId: string,
  mode: string,
  level: string | null,
): Promise<void> {
  const r = await fetch(
    `/api/admin/providers/${providerId}/models/${encodeURIComponent(modelId)}?mode=${encodeURIComponent(mode)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ default_reasoning_level: level }),
    },
  );
  if (!r.ok) {
    const err = (await r.json().catch(() => ({ error: r.statusText }))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${r.status}`);
  }
}

export async function setModelContextWindow(
  providerId: string,
  modelId: string,
  mode: string,
  value: number | null,
): Promise<void> {
  const r = await fetch(
    `/api/admin/providers/${providerId}/models/${encodeURIComponent(modelId)}?mode=${encodeURIComponent(mode)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context_window: value }),
    },
  );
  if (!r.ok) {
    const err = (await r.json().catch(() => ({ error: r.statusText }))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${r.status}`);
  }
}

export async function setModelMaxTools(
  providerId: string,
  modelId: string,
  mode: string,
  value: number | null,
): Promise<void> {
  const r = await fetch(
    `/api/admin/providers/${providerId}/models/${encodeURIComponent(modelId)}?mode=${encodeURIComponent(mode)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_tools: value }),
    },
  );
  if (!r.ok) {
    const err = (await r.json().catch(() => ({ error: r.statusText }))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${r.status}`);
  }
}

/**
 * Backfill `provider_models.context_window` for every row that has it null,
 * pulling values from the static registry's prefix-aware lookup. Returns
 * counts of updated/still-null rows so the UI can display "X resolved, Y
 * still unknown".
 */
export async function backfillContextWindows(): Promise<{ updated: number; still_null: number; total: number }> {
  const r = await fetch('/api/admin/providers/models/backfill-context-windows', { method: 'POST' });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({ error: r.statusText }))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${r.status}`);
  }
  return r.json() as Promise<{ updated: number; still_null: number; total: number }>;
}

// ── Phase G — capability fallback visibility ────────────────────────────────

export interface CapabilityFallbackEvent {
  model: string;
  source: 'inferred' | 'fallback';
  via: string;
  window: number;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
}

export interface ResolveCapabilityResponse {
  model: string;
  static: {
    window: number;
    source: 'registry-exact' | 'registry-prefix' | 'inferred' | 'fallback';
    via: string;
  };
  runtime: {
    window: number;
    effective: number;
    reservedOutput: number;
    isFallback: boolean;
    source: 'registry' | 'inferred' | 'fallback';
    via?: string;
  };
}

export async function fetchCapabilityFallbacks(): Promise<CapabilityFallbackEvent[]> {
  const r = await fetch('/api/admin/capabilities/fallbacks');
  const j = (await r.json()) as { fallbacks: CapabilityFallbackEvent[] };
  return j.fallbacks ?? [];
}

export async function previewCapabilityResolution(model: string): Promise<ResolveCapabilityResponse> {
  const r = await fetch(`/api/admin/capabilities/resolve?model=${encodeURIComponent(model)}`);
  if (!r.ok) {
    const err = (await r.json().catch(() => ({ error: r.statusText }))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${r.status}`);
  }
  return r.json() as Promise<ResolveCapabilityResponse>;
}
