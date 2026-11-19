import type { SettingDef } from './types.js';

/** Advanced model-id overrides. Provider credentials live in the Providers panel. */
export const LLM_SETTINGS: readonly SettingDef[] = [
  {
    key: 'MODEL_PRICING_REMOTE_ENABLED',
    label: 'Sync model prices online',
    description: 'Fetch prices from OpenRouter and LiteLLM. Turning this off uses prices already stored on this machine.',
    type: 'bool',
    category: 'llm',
    default: 'true',
  },
  {
    key: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    label: 'Anthropic Sonnet model id',
    description: 'Override the default `claude-sonnet-*` model id used by Anthropic-backed sessions.',
    type: 'string',
    category: 'llm',
    advanced: true,
  },
  {
    key: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    label: 'Anthropic Opus model id',
    description: 'Override the default `claude-opus-*` model id.',
    type: 'string',
    category: 'llm',
    advanced: true,
  },
  {
    key: 'ANTHROPIC_SMALL_FAST_MODEL',
    label: 'Anthropic small/fast model id',
    description: 'Used by sub-agents and other cheap calls. Defaults to claude-haiku.',
    type: 'string',
    category: 'llm',
    advanced: true,
  },
];
