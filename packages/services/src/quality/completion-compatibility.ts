import type { ResolvedBinding } from '../pipelines/index.js';
import { CODER_CHAT_KINDS } from './binding-chat.js';

export type CompletionSuitability =
  | 'native-fim'
  | 'template-fim'
  | 'verified-fast-chat'
  | 'best-effort-chat';

const NATIVE_FIM_MODEL_RE = /(deepseek-coder|codestral|devstral)/i;
const TEMPLATE_FIM_MODEL_RE = /(qwen[\d.]*-?coder|starcoder|stable-?code|codegemma|\bfim\b)/i;

export interface CompletionCompatibility {
  suitability: CompletionSuitability;
  transport: 'native-fim' | 'template-fim' | 'chat' | 'oauth-chat';
  automatic: boolean;
  reason?: string;
}

export interface CompletionProbeStamp {
  version: 1;
  prompts: number;
  passed: boolean;
  p50Ms: number;
  p90Ms: number;
  providerId: string;
  model: string;
  testedAt: string;
}

function probeStamp(binding: ResolvedBinding): CompletionProbeStamp | null {
  const raw = (binding.config as Record<string, unknown>).completion_probe;
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<CompletionProbeStamp>;
  if (
    p.version !== 1 || p.passed !== true || typeof p.prompts !== 'number' || p.prompts < 3
    || p.providerId !== binding.provider.id || p.model !== binding.modelId
    || typeof p.p50Ms !== 'number' || typeof p.p90Ms !== 'number'
  ) return null;
  return p as CompletionProbeStamp;
}

/** Stable revision shared by cache/circuit/probe state. Credentials are excluded. */
export function completionBindingRevision(binding: ResolvedBinding): string {
  const cfg = binding.config as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(cfg).sort()) sorted[key] = cfg[key];
  return `${binding.bindingId ?? 'fallback'}:${binding.provider.id}:${binding.provider.updated_at ?? ''}:${binding.modelId}:${JSON.stringify(sorted)}`;
}

/**
 * Conservative completion suitability. Generic chat is manual-only until a
 * three-prompt probe is persisted on this exact provider/model/config.
 */
export function completionCompatibility(binding: ResolvedBinding): CompletionCompatibility {
  const cfg = binding.config as Record<string, unknown>;
  const explicitFim = cfg.fim === true;
  const reasoningChatOnly = /(reasoner|\br1\b|-r1|think)/i.test(binding.modelId) && !explicitFim;
  const native = !reasoningChatOnly && (explicitFim
    || binding.provider.kind === 'deepseek'
    || (binding.provider.kind === 'mistral' && NATIVE_FIM_MODEL_RE.test(binding.modelId)));
  if (native) {
    return { suitability: 'native-fim', transport: 'native-fim', automatic: true };
  }
  if (!reasoningChatOnly && cfg.fim !== false && TEMPLATE_FIM_MODEL_RE.test(binding.modelId)) {
    return { suitability: 'template-fim', transport: 'template-fim', automatic: true };
  }
  const stamp = probeStamp(binding);
  if (stamp && stamp.p50Ms <= 750 && stamp.p90Ms <= 1500) {
    return { suitability: 'verified-fast-chat', transport: CODER_CHAT_KINDS.has(binding.provider.kind) ? 'oauth-chat' : 'chat', automatic: true };
  }
  if (cfg.allow_degraded_auto === true) {
    return {
      suitability: 'best-effort-chat',
      transport: CODER_CHAT_KINDS.has(binding.provider.kind) ? 'oauth-chat' : 'chat',
      automatic: true,
      reason: 'Automatic completion is enabled by allow_degraded_auto.',
    };
  }
  return {
    suitability: 'best-effort-chat',
    transport: CODER_CHAT_KINDS.has(binding.provider.kind) ? 'oauth-chat' : 'chat',
    automatic: false,
    reason: 'This chat model is manual-only until it passes the 3-prompt completion probe.',
  };
}

export function makeCompletionProbeStamp(
  binding: ResolvedBinding,
  latencies: number[],
  passed: boolean,
): CompletionProbeStamp {
  const sorted = [...latencies].sort((a, b) => a - b);
  const at = (p: number) => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!) : 0;
  return {
    version: 1,
    prompts: latencies.length,
    passed,
    p50Ms: at(0.5),
    p90Ms: at(0.9),
    providerId: binding.provider.id,
    model: binding.modelId,
    testedAt: new Date().toISOString(),
  };
}
