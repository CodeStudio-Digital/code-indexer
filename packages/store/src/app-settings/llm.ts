import type { SettingDef } from './types.js';

/** LLM & API keys. Provider credentials live in the Providers panel — NOT here. */
export const LLM_SETTINGS: readonly SettingDef[] = [
  {
    key: 'ZAI_MAX_TOKENS',
    label: 'Z.AI max output tokens',
    description: 'Cap on completion length for GLM models. 32000 covers most coding tasks.',
    type: 'int',
    category: 'llm',
    default: '32000',
    min: 1,
    max: 131072,
  },
  {
    key: 'BRAVE_API_KEY',
    label: 'Brave Search API key',
    description: 'Powers the agent\'s web_search tool. Get a key at brave.com/search/api.',
    type: 'secret',
    category: 'llm',
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
