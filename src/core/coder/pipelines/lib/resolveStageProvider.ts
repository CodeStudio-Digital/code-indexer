/**
 * resolveStageProvider — produces a `ChatProvider` for one pipeline
 * stage, honoring the node's `model_override` when set.
 *
 * Provider construction has non-trivial cost (credentials lookup,
 * OAuth refresh in some shapes), so we cache by `(provider, model)`
 * tuple within a single execution. The cache is owned by the caller —
 * the executor instantiates one cache per `pipeline_executions` row
 * and discards it on completion.
 *
 * When the node has no override (or both fields are empty), we return
 * the parent's provider unchanged. This is the common case for
 * agent-kind nodes that just want to inherit the chat session's model.
 */
import type { ChatProvider } from '../../providers/adapter.js';
import { createCoderProvider } from '../../../providers/factory.js';
import type { PipelineNode } from '../../company/types.js';

export type ProviderCache = Map<string, ChatProvider>;

export function makeProviderCache(): ProviderCache {
  return new Map();
}

export async function resolveStageProvider(args: {
  node: PipelineNode;
  defaultProvider: ChatProvider;
  cache: ProviderCache;
}): Promise<ChatProvider> {
  const override = args.node.model_override;
  const providerName = override?.provider?.trim();
  const model = override?.model?.trim();

  // No override (or both fields empty/whitespace) → inherit the parent's
  // provider instance. No cache key needed.
  if (!providerName && !model) return args.defaultProvider;

  const effectiveProvider = providerName ?? args.defaultProvider.name ?? '';
  const effectiveModel = model ?? args.defaultProvider.model ?? '';
  const key = `${effectiveProvider}::${effectiveModel}`;

  const cached = args.cache.get(key);
  if (cached) return cached;

  const fresh = await createCoderProvider(effectiveProvider || undefined, effectiveModel || undefined);
  args.cache.set(key, fresh);
  return fresh;
}
