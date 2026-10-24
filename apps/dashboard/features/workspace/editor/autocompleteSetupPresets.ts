/**
 * Completion-model setup presets + apply sequence. The fast path to a
 * working ghost text: pick a preset → paste a key → provider + model +
 * editor/autocomplete binding created with tuned defaults → feature enabled.
 * Reuses provider/model CRUD and the editor's synthetic completion probe, so
 * setup validates the exact transport that ghost text will use.
 */
import type { EditorProbeResult } from '@mcp/api-bus';
import { saveProvider, addProviderModel, fetchProviders, fetchProviderModels } from '../../admin/api.js';
import { activateBinding } from '../../admin/pipeline-bindings-api.js';
import { apiCall } from '../../../lib/api-client.js';

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
    keyUrl: 'https://console.mistral.ai/api-keys/',
    provider: {
      id: 'mistral-codestral', kind: 'mistral', name: 'Mistral / Codestral',
      base_url: 'https://api.mistral.ai/v1',
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
    description: 'Bind an existing chat model for explicit Alt+\\ completion. Automatic ghost text unlocks only after the 3-prompt completion probe meets the latency SLO.',
    bindingConfig: {
      temperature: 0.1, max_tokens: 192, max_tokens_single_line: 64,
      multiline: 'auto', aggressiveness: 'economic', timeout_ms: 8000,
    },
  },
];

interface ApplyAcPresetInput {
  apiKey?: string;
  baseUrl?: string;
  modelId?: string;
  existingProviderId?: string;
  existingModelId?: string;
}

interface ApplyAcPresetResult {
  ok: boolean;
  error?: string;
  /** Real synthetic completion probe failed but the binding can still be forced. */
  testWarning?: string;
  probe?: EditorProbeResult;
  forced?: boolean;
}

export function formatCompletionProbeFailure(preset: AcPreset, probe: EditorProbeResult): string {
  const statuses = probe.samples.filter((sample) => sample.status !== 'ok').map((sample) => sample.status);
  const status = statuses[0];
  let hint = '';
  if (preset.id === 'codestral-free') {
    if (status === 'http_401' || status === 'http_403') {
      hint = ' The API key was rejected by api.mistral.ai; verify the key and workspace access in Mistral Console.';
    } else if (status === 'http_404') {
      hint = ' The current Codestral FIM endpoint is api.mistral.ai/v1/fim/completions; retrying this preset rewrites stale provider hosts.';
    } else if (status === 'http_429') {
      hint = ' The key reached its Mistral rate limit; wait for the retry window and test again.';
    }
  }
  return `${probe.message ?? 'The provider returned no usable completion.'}${hint}`;
}

export async function applyAcPreset(
  preset: AcPreset,
  input: ApplyAcPresetInput,
  opts: { bindAnyway?: boolean; relatedCodeConsent?: boolean } = {},
): Promise<ApplyAcPresetResult> {
  try {
    let providerId: string;
    let modelId: string;
    let probe: EditorProbeResult | undefined;
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
    }

    if (!opts.bindAnyway) {
      probe = await apiCall<EditorProbeResult>('editor.probe', { providerId, modelId }).catch(() => ({
        ok: false, samples: [], latency: { p50: null, p90: null },
        verifiedForAutomatic: false, message: 'Could not reach the completion probe.',
      }));
      if (!probe.ok) return { ok: false, testWarning: formatCompletionProbeFailure(preset, probe) };
    }

    await activateBinding({
      pipeline_name: 'editor',
      binding_role: 'autocomplete',
      provider_id: providerId,
      model_id: modelId,
      config: {
        ...preset.bindingConfig,
        context_engine: 'v3',
        ctx_related_code: opts.relatedCodeConsent === true,
        ...(opts.relatedCodeConsent === true ? { ctx_related_code_consent_v: 1 } : {}),
      },
    });
    return { ok: true, probe, forced: opts.bindAnyway === true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
