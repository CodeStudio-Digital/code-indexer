import { describe, expect, it } from 'vitest';
import { CHATGPT_SEED_MODELS } from '@mcp/services/services/oauth/openai.js';
import { chatgptSpec } from '../specs/chatgpt.js';

const CODEX_MODEL_IDS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark',
] as const;

describe('ChatGPT Codex catalog', () => {
  it('keeps the static provider list and offline discovery seed in lockstep', () => {
    expect(chatgptSpec.defaultModels).toEqual(CODEX_MODEL_IDS);
    expect(CHATGPT_SEED_MODELS.map((model) => model.model_id)).toEqual(CODEX_MODEL_IDS);
    expect(Object.keys(chatgptSpec.pricing ?? {})).toEqual(CODEX_MODEL_IDS);
    expect(Object.values(chatgptSpec.pricing ?? {})).toEqual(
      CODEX_MODEL_IDS.map(() => ({ inputPer1M: 0, outputPer1M: 0 })),
    );
  });

  it('uses the account-scoped Codex context and reasoning metadata offline', () => {
    expect(CHATGPT_SEED_MODELS).toEqual(expect.arrayContaining([
      expect.objectContaining({
        model_id: 'gpt-5.6-sol',
        context_window: 272_000,
        default_reasoning_level: 'low',
        supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        apply_patch_tool_type: 'freeform',
      }),
      expect.objectContaining({
        model_id: 'gpt-5.3-codex-spark',
        context_window: 128_000,
        default_reasoning_level: 'high',
        supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'],
        apply_patch_tool_type: 'freeform',
      }),
    ]));
  });
});
