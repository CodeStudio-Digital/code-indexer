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
  // 2.5-flash, not the 2.0-flash that leads the list — 2.0-flash's free quota
  // is 0 as of April 2026 and returns 429 immediately for a bare provider pick.
  defaultModel: 'gemini-2.5-flash',
  defaultModels: ['gemini-2.0-flash', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  pricing: {
    'gemini-2.0-flash': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10.0 },
    'gemini-2.5-flash': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'gemini-2.5-flash-lite': { inputPer1M: 0.0, outputPer1M: 0.0 },
  },
  capabilities: { supportsThinking: true, supportsVision: true, supportsImageGen: true },
  wire: 'gemini',
  discovery: { from: 'gemini-models' },
  test: { from: 'gemini-key' },
};

export const GEMINI_SPECS: ProviderSpec[] = [geminiSpec];
