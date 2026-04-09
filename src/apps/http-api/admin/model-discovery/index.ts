/**
 * Live model discovery dispatcher.
 *
 * Per-kind fetchers are split into sibling files; this module picks the right
 * one based on `cfg.kind` and returns `UpsertModelInput[]` that the caller
 * stores via `ProviderStore.replaceModelsFromSource(..., 'live', ...)`.
 *
 * Intentionally not unified with src/agent/providers/model-discovery.ts —
 * that class is scoped to the agent indexer and carries DiscoveredModel
 * typing that doesn't quite match UpsertModelInput. A later slice can merge
 * them.
 */
import type {
  ProviderStore,
  ProviderConfig,
  UpsertModelInput,
} from '../../../../store/provider-store.js';
import { discoverChatgpt } from './chatgpt.js';
import { discoverCopilot } from './copilot.js';
import { discoverOpenai } from './openai.js';
import { discoverAnthropic } from './anthropic.js';
import { discoverGemini } from './gemini.js';
import { discoverBedrock } from './bedrock.js';

export async function discoverModels(
  store: ProviderStore,
  cfg: ProviderConfig
): Promise<UpsertModelInput[]> {
  switch (cfg.kind) {
    case 'chatgpt':
      return discoverChatgpt();
    case 'copilot':
      return discoverCopilot(store, cfg);
    case 'openai':
      return discoverOpenai(cfg);
    case 'anthropic':
      return discoverAnthropic(cfg);
    case 'gemini':
      return discoverGemini(cfg);
    case 'bedrock':
      return discoverBedrock(cfg);
    default:
      throw new Error(`Live discovery not implemented for kind=${cfg.kind}`);
  }
}
