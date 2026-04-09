/**
 * ChatGPT (Codex backend) model discovery.
 *
 * The Codex backend does NOT expose /models to OAuth tokens. Both opencode
 * (packages/opencode/src/plugin/codex.ts) and the official Codex CLI hardcode
 * an allowlist of Codex-capable models. We mirror opencode's list in
 * CHATGPT_SEED_MODELS — update it there when OpenAI ships new models.
 */
import type { UpsertModelInput } from '../../../../store/provider-store.js';
import { CHATGPT_SEED_MODELS } from '../../../../core/services/oauth/openai.js';

export async function discoverChatgpt(): Promise<UpsertModelInput[]> {
  return CHATGPT_SEED_MODELS.map((m) => ({
    model_id: m.model_id,
    name: m.name,
    source: 'live' as const,
  }));
}
