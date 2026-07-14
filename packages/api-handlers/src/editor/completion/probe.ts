import type { EditorCompletionRoute, EditorProbeInput, EditorProbeResult } from '@mcp/api-bus';
import type { ResolvedBinding } from '@mcp/services/pipelines/provider-resolver.js';
import { bindingProblem, callConfiguredChat } from '@mcp/services/quality/binding-chat.js';
import { completionCompatibility, makeCompletionProbeStamp } from '@mcp/services/quality/completion-compatibility.js';
import { fimCompletion, supportsFim } from '@mcp/services/quality/fim-completion.js';
import type { HandlerDeps } from '../../types.js';
import { buildCompletionMessages } from '../completion-prompt.js';

type ProbeDeps = Pick<HandlerDeps, 'pipelineProviderResolver'> & Partial<Pick<HandlerDeps, 'pipelineBindingsStore' | 'providerStore'>>;

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!);
}

function route(binding: ResolvedBinding, health: EditorCompletionRoute['health'], reason?: string): EditorCompletionRoute {
  const c = completionCompatibility(binding);
  return {
    bindingId: binding.bindingId, providerId: binding.provider.id,
    provider: binding.provider.name || binding.provider.id, model: binding.modelId,
    transport: c.transport, suitability: c.suitability, health,
    ...(reason || c.reason ? { reason: reason ?? c.reason } : {}),
  };
}

export async function runCompletionProbe(deps: ProbeDeps, input: EditorProbeInput = {}): Promise<EditorProbeResult> {
  let binding: ResolvedBinding | undefined;
  if (input.providerId || input.modelId) {
    if (!input.providerId || !input.modelId) {
      return { ok: false, samples: [], latency: { p50: null, p90: null }, verifiedForAutomatic: false, message: 'Both providerId and modelId are required.' };
    }
    const provider = deps.providerStore?.getProvider(input.providerId);
    if (provider) {
      binding = {
        pipelineName: 'editor', bindingRole: 'autocomplete', provider,
        modelId: input.modelId, modelMode: 'normal', config: {},
        resolvedFrom: 'fallback', bindingId: null,
      };
    }
  } else {
    const chain = await deps.pipelineProviderResolver.resolveChain('editor', 'autocomplete', {});
    binding = input.bindingId == null ? chain[0] : chain.find((b) => b.bindingId === input.bindingId);
  }
  if (!binding) return {
    ok: false, samples: [], latency: { p50: null, p90: null }, verifiedForAutomatic: false,
    message: input.providerId ? 'Provider/model not found.' : 'Binding not found.',
  };
  const problem = bindingProblem(binding, { label: 'editor/autocomplete', codePrefix: 'autocomplete_probe' });
  if (problem) return { ok: false, route: route(binding, 'degraded', problem.message), samples: [], latency: { p50: null, p90: null }, verifiedForAutomatic: false, message: problem.message };
  const prompts = [
    { language: 'typescript', prefix: 'function add(a: number, b: number) {\n  return ', suffix: '\n}' },
    { language: 'php', prefix: '<?php\nfunction normalize(string $value): string {\n    return ', suffix: ';\n}' },
    { language: 'python', prefix: 'def clamp(value, minimum, maximum):\n    return ', suffix: '\n' },
  ];
  const samples: EditorProbeResult['samples'] = [];
  const latencies: number[] = [];
  for (const p of prompts) {
    const opts = { maxTokens: 64, temperature: 0, timeoutMs: 1_750, stop: ['\n\n', '```'], signal: new AbortController().signal, reasoningEffort: 'minimal' };
    const messages = buildCompletionMessages({ language: p.language, file: `probe.${p.language}`, windows: p });
    const result = supportsFim(binding)
      ? await fimCompletion(binding, { ...p, context: '', filePath: `probe.${p.language}`, repoName: 'synthetic-probe' }, opts)
      : await callConfiguredChat(binding, messages, opts);
    const status = result.status != null
      ? `http_${result.status}`
      : result.errorBody ? (result.finishReason ?? 'error') : result.content.trim() ? 'ok' : 'empty';
    samples.push({ language: p.language, latencyMs: Math.round(result.latencyMs), ttftMs: result.ttftMs == null ? null : Math.round(result.ttftMs), status });
    latencies.push(result.latencyMs);
  }
  const p50 = percentile(latencies, 0.5);
  const p90 = percentile(latencies, 0.9);
  const passed = samples.length === 3 && samples.every((s) => s.status === 'ok') && (p50 ?? Infinity) <= 750 && (p90 ?? Infinity) <= 1_500;
  const stamp = makeCompletionProbeStamp(binding, latencies, passed);
  if (binding.bindingId != null && deps.pipelineBindingsStore) {
    const row = deps.pipelineBindingsStore.get(binding.bindingId);
    if (row) deps.pipelineBindingsStore.update(row.id, {
      pipeline_name: row.pipeline_name, binding_role: row.binding_role,
      provider_id: row.provider_id, model_id: row.model_id, model_mode: row.model_mode,
      config: { ...row.config, completion_probe: stamp }, scope_type: row.scope_type,
      scope_id: row.scope_id, enabled: row.enabled, priority: row.priority,
    });
  }
  const updated = { ...binding, config: { ...binding.config, completion_probe: stamp } };
  return {
    ok: samples.every((s) => s.status === 'ok'), route: route(updated, passed ? 'healthy' : 'degraded'),
    samples, latency: { p50, p90 }, verifiedForAutomatic: passed,
    message: samples.every((s) => s.status === 'ok')
      ? (passed ? 'Verified for automatic completion.' : 'Probe completed, but this model missed the automatic-completion SLO.')
      : `Completion probe failed: ${samples.filter((s) => s.status !== 'ok').map((s) => `${s.language}=${s.status}`).join(', ')}.`,
  };
}
