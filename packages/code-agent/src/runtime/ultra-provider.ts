import { randomUUID } from 'node:crypto';
import type { ChatProvider } from '@mcp/provider-sdk';
import type { CollaborationBudget } from '@mcp/session-storage/collaboration/budget.js';

const wrapped = new WeakMap<ChatProvider, string>();

/** Account actual physical provider attempts at the shared root. No transcript
 * or credentials enter the ledger. Missing cost remains unknown, never zero. */
export function budgetedProvider(provider: ChatProvider, ledger?: CollaborationBudget): ChatProvider {
  if (!ledger) return provider;
  if (wrapped.get(provider) === ledger.rootId) return provider;
  const result: ChatProvider = {
    get reasoningCapabilities() { return provider.reasoningCapabilities; },
    get name() { return provider.name; }, get model() { return provider.model; }, set model(value) { provider.model = value; },
    get toolLimits() { return provider.toolLimits; }, setModel: model => provider.setModel(model),
    async *chat(request) {
      const state = await ledger.state();
      // The generic provider interface has no guaranteed token/cost ceiling.
      // A hard cap cannot be enforced from an estimate or absent price data.
      if (state.limits.maxTokens !== undefined || state.limits.maxCostUsd !== undefined) throw new Error('budget_bound_unavailable: provider needs a verified maximum charge before admission');
      const id = `model:${randomUUID()}`;
      await ledger.reserve(id, request.sessionId ?? provider.name, 0, null, 'model');
      let tokens = 0, cost: number | null = null, terminal = false;
      const attempts: Array<{ tokens: number; cost: number | null }> = [];
      try {
        for await (const delta of provider.chat({ ...request, onAttempt: async attempt => {
          attempts.push({ tokens: (attempt.inputTokens ?? 0) + (attempt.outputTokens ?? 0), cost: attempt.costUsd ?? null });
          await request.onAttempt?.(attempt);
        } })) {
          if (delta.type === 'usage') tokens = Math.max(tokens, (delta.usage.prompt_tokens_total ?? delta.usage.input_tokens) + delta.usage.output_tokens);
          yield delta;
        }
        terminal = true;
      } finally {
        if (attempts.length) {
          tokens = Math.max(tokens, attempts.reduce((sum, a) => sum + a.tokens, 0));
          cost = attempts.every(a => a.cost !== null) ? attempts.reduce((sum, a) => sum + a.cost!, 0) : null;
        }
        await ledger.settle(id, tokens, cost, !terminal);
      }
    },
  };
  wrapped.set(result, ledger.rootId);
  return result;
}
