import type { ServerDeps } from '../../deps.js';
import { createCoderProvider } from '@mcp/services/providers/factory.js';
import {
  summarizeSpanV3,
  type CompactionSummaryV3,
  type SummarizeSpanV3Input,
  type SummarizeSpanV3Options,
} from '@mcp/code-agent/core/summarizer.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { CoderSession } from '@mcp/code-agent/sessions/types.js';

export interface ReliableSummaryResult {
  summary: CompactionSummaryV3 | null;
  provider: string | null;
  model: string | null;
  providerChain: Array<{ provider: string; model: string }>;
  errors: string[];
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function compactionOptionsFromConfig(
  config: Record<string, unknown> | null | undefined,
): Omit<SummarizeSpanV3Options, 'signal'> {
  if (!config) return {};
  return {
    timeoutMs: positiveNumber(config.timeout_ms),
    budgetChars: positiveNumber(config.budget_chars),
    maxOutputTokens: positiveNumber(config.max_tokens),
    temperature: typeof config.temperature === 'number' && Number.isFinite(config.temperature)
      ? Math.max(0, Math.min(2, config.temperature))
      : undefined,
    reasoningEffort: typeof config.reasoning_effort === 'string' ? config.reasoning_effort : undefined,
  };
}

/** Resolve auxiliary then session provider, preserving the binding's request config. */
export async function resolveCompactionProviders(
  deps: ServerDeps,
  session: CoderSession,
  sessionId: number,
): Promise<{
  providers: ChatProvider[];
  options: Omit<SummarizeSpanV3Options, 'signal'>;
  errors: string[];
}> {
  const providers: ChatProvider[] = [];
  const errors: string[] = [];
  let options: Omit<SummarizeSpanV3Options, 'signal'> = {};
  let binding: Awaited<ReturnType<typeof deps.pipelineProviderResolver.resolveOrNull>> = null;
  try {
    binding = await deps.pipelineProviderResolver.resolveOrNull(
      'code-agent',
      'compaction',
      { sessionId },
    );
  } catch (error) {
    errors.push(`compaction binding: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (binding) {
    options = compactionOptionsFromConfig(binding.config);
    try {
      providers.push(await createCoderProvider(binding.provider.id, binding.modelId));
    } catch (error) {
      errors.push(
        `${binding.provider.name}/${binding.modelId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const sessionProvider = await createCoderProvider(session.provider, session.model);
  if (!providers.some((candidate) => (
    candidate.name === sessionProvider.name && candidate.model === sessionProvider.model
  ))) {
    providers.push(sessionProvider);
  }
  return { providers, options, errors };
}

/** Strict structured summary with an explicit auxiliary -> session fallback chain. */
export async function summarizeReliably(
  input: SummarizeSpanV3Input,
  providers: readonly ChatProvider[],
  options: Omit<SummarizeSpanV3Options, 'signal'> = {},
  initialErrors: readonly string[] = [],
): Promise<ReliableSummaryResult> {
  const errors: string[] = [...initialErrors];
  const providerChain = providers.map((provider) => ({
    provider: provider.name,
    model: provider.model,
  }));
  for (const provider of providers) {
    try {
      const summary = await summarizeSpanV3(input, provider, options);
      if (summary) {
        return {
          summary,
          provider: provider.name,
          model: provider.model,
          providerChain,
          errors,
        };
      }
      errors.push(`${provider.name}/${provider.model}: no valid V3 JSON`);
    } catch (error) {
      errors.push(`${provider.name}/${provider.model}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { summary: null, provider: null, model: null, providerChain, errors };
}
