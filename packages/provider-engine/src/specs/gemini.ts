import type { ProviderSpec } from '@mcp/provider-sdk';

/**
 * Declarative spec for the native Gemini built-in (api-key). The OAuth variant
 * (google-oauth) is represented by its own spec.
 */
export const geminiSpec: ProviderSpec = {
  kind: 'gemini',
  displayName: 'Google Gemini',
  visual: { icon: 'Zap', fg: 'text-sky-500', bg: 'bg-sky-500/15' },
  credKind: 'api-key',
  envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  defaultModel: 'gemini-3.6-flash',
  defaultModels: [
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.1-pro',
    'gemini-3.1-flash-lite',
  ],
  // Live discovery is authoritative for the current catalog. Keep historical
  // prices for persisted usage, without guessing prices for new tiers.
  pricing: {
    'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10.0 },
    'gemini-2.5-flash': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'gemini-2.5-flash-lite': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'gemini-2.0-flash': { inputPer1M: 0.0, outputPer1M: 0.0 },
  },
  capabilities: { supportsThinking: true, supportsVision: true, supportsImageGen: true, fileInput: 'pdf-only' },
  wire: 'gemini',
  discovery: { from: 'gemini-models' },
  test: { from: 'gemini-key' },
  models: {
    'gemini-3.6-flash': {
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      canReason: true,
      supportsAttachments: true,
      supportedReasoningLevels: ['minimal', 'low', 'medium', 'high'],
      defaultReasoningLevel: 'medium',
    },
    'gemini-3.5-flash': {
      canReason: true,
      supportsAttachments: true,
      supportedReasoningLevels: ['minimal', 'low', 'medium', 'high'],
      defaultReasoningLevel: 'medium',
    },
    'gemini-3.1-pro': {
      canReason: true,
      supportsAttachments: true,
      supportedReasoningLevels: ['low', 'medium', 'high'],
      defaultReasoningLevel: 'high',
    },
    'gemini-3.1-flash-lite': {
      canReason: true,
      supportsAttachments: true,
      supportedReasoningLevels: ['minimal', 'low', 'medium', 'high'],
      defaultReasoningLevel: 'minimal',
    },
  },
};

export const GEMINI_SPECS: ProviderSpec[] = [geminiSpec];
