import type { AdminModel, AdminProvider, TestResult } from './types.js';

export async function fetchProviders(): Promise<AdminProvider[]> {
  const r = await fetch('/api/admin/providers');
  const j = (await r.json()) as { providers: AdminProvider[] };
  return j.providers;
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

export async function setKimiCodeThinkingMode(
  provider: AdminProvider,
  mode: 'auto' | 'enabled' | 'disabled',
): Promise<void> {
  const r = await fetch(`/api/admin/providers/${provider.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      extra: {
        ...provider.extra,
        kimi_code_thinking_mode: mode,
      },
    }),
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
