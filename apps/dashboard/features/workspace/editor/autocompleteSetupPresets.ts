/**
 * Completion-model setup presets + apply sequence. The fast path to a
 * working ghost text: pick a preset → paste a key → provider + model +
 * editor/autocomplete binding created with tuned defaults → feature enabled.
 * Reuses the admin endpoints (providers CRUD, model add, test, binding
 * upsert) — no new server routes.
 */
import { saveProvider, addProviderModel, testProvider, fetchProviders, fetchProviderModels } from '../../admin/api.js';
import { upsertBinding } from '../../admin/pipeline-bindings-api.js';

export interface AcPreset {
  id: 'codestral-free' | 'deepseek' | 'qwen-compat' | 'chat-model';
  label: string;
  description: string;
  /** Console URL where the user creates the API key. */
  keyUrl?: string;
  provider?: { id: string; kind: string; name: string; base_url?: string; needsBaseUrl?: boolean };
  /** Fixed model id; undefined = the user supplies one (qwen-compat). */
  modelId?: string;
  bindingConfig: Record<string, unknown>;
}

export const AC_PRESETS: AcPreset[] = [
  {
    id: 'codestral-free',
    label: 'Codestral (free tier)',
    description: 'Mistral\'s code model with a native fill-in-the-middle endpoint. Free API key, fast, the recommended choice.',
    keyUrl: 'https://console.mistral.ai/codestral',
    provider: {
      id: 'mistral-codestral', kind: 'mistral', name: 'Mistral / Codestral',
      // Free-tier keys ONLY work on this host (paid keys on api.mistral.ai).
      base_url: 'https://codestral.mistral.ai/v1',
    },
    modelId: 'codestral-latest',
    bindingConfig: {
      temperature: 0.05, max_tokens: 256, max_tokens_single_line: 64,
      multiline: 'auto', aggressiveness: 'balanced', timeout_ms: 4000,
    },
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'Native FIM via the beta endpoint. Very cheap; slower than Codestral at peak hours.',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    provider: { id: 'deepseek', kind: 'deepseek', name: 'DeepSeek' },
    modelId: 'deepseek-chat',
    bindingConfig: {
      temperature: 0.05, max_tokens: 256, max_tokens_single_line: 64,
      multiline: 'auto', aggressiveness: 'balanced', timeout_ms: 5000,
    },
  },
  {
    id: 'qwen-compat',
    label: 'Qwen-coder (any host)',
    description: 'A qwen2.5-coder (or similar FIM model) on any OpenAI-compatible host you run or rent.',
    provider: { id: 'qwen-coder-host', kind: 'openai', name: 'Qwen coder host', needsBaseUrl: true },
    bindingConfig: {
      temperature: 0.05, max_tokens: 256, max_tokens_single_line: 64,
      multiline: 'auto', aggressiveness: 'balanced', timeout_ms: 5000, fim_template: 'auto',
    },
  },
  {
    id: 'chat-model',
    label: 'Use an existing provider',
    description: 'Bind a chat model you already configured. Works, but ghost text is only as fast as the model.',
    bindingConfig: {
      temperature: 0.1, max_tokens: 192, max_tokens_single_line: 64,
      multiline: 'auto', aggressiveness: 'economic', timeout_ms: 8000,
    },
  },
];

export interface ApplyAcPresetInput {
  apiKey?: string;
  baseUrl?: string;
  modelId?: string;
  existingProviderId?: string;
  existingModelId?: string;
}

export interface ApplyAcPresetResult {
  ok: boolean;
  error?: string;
  /** Provider /test probe failed but the binding can still be forced. */
  testWarning?: string;
}

export async function applyAcPreset(
  preset: AcPreset,
  input: ApplyAcPresetInput,
  opts: { bindAnyway?: boolean } = {},
): Promise<ApplyAcPresetResult> {
  try {
    let providerId: string;
    let modelId: string;
    if (preset.id === 'chat-model') {
      if (!input.existingProviderId || !input.existingModelId) {
        return { ok: false, error: 'Pick a provider and a model.' };
      }
      providerId = input.existingProviderId;
      modelId = input.existingModelId;
    } else {
      const spec = preset.provider!;
      providerId = spec.id;
      modelId = preset.modelId ?? input.modelId ?? '';
      if (!input.apiKey?.trim()) return { ok: false, error: 'An API key is required.' };
      if (!modelId.trim()) return { ok: false, error: 'A model id is required.' };
      const baseUrl = spec.needsBaseUrl ? input.baseUrl?.trim() : (spec.base_url ?? undefined);
      if (spec.needsBaseUrl && !baseUrl) return { ok: false, error: 'The host base URL is required.' };

      const existing = (await fetchProviders().catch(() => [])).some((p) => p.id === providerId);
      await saveProvider(
        {
          id: providerId, kind: spec.kind as never, name: spec.name,
          api_key: input.apiKey.trim(), base_url: baseUrl ?? null, enabled: true,
        } as never,
        existing,
      );
      const models = await fetchProviderModels(providerId).catch(() => []);
      if (!models.some((m) => m.model_id === modelId)) {
        await addProviderModel(providerId, { model_id: modelId, name: modelId });
      }
      const test = await testProvider(providerId).catch(() => ({ ok: false, error: 'probe failed' }));
      if (!(test as { ok?: boolean }).ok && !opts.bindAnyway) {
        const err = (test as { error?: string }).error ?? 'unknown';
        const hint = preset.id === 'codestral-free'
          ? ' A 401 usually means the key/host pairing is wrong: FREE Codestral keys only work on codestral.mistral.ai; paid keys on api.mistral.ai.'
          : '';
        return { ok: false, testWarning: `Provider test failed: ${err}.${hint}` };
      }
    }

    await upsertBinding({
      pipeline_name: 'editor',
      binding_role: 'autocomplete',
      provider_id: providerId,
      model_id: modelId,
      scope_type: 'global',
      config: preset.bindingConfig,
      enabled: true,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
