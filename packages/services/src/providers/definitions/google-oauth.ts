import { defineProvider } from '../types.js';
import { GeminiProvider } from '@mcp/indexer/indexer/providers/gemini.js';
import { GeminiChatProvider } from '@mcp/code-agent/providers/gemini.js';

/**
 * Google Gemini via OAuth 2.0 — "Sign in with Google" (PKCE loopback flow).
 *
 * Uses the same native Gemini SDK as the api-key `gemini` definition, but
 * authenticates with an OAuth Bearer token instead of a static API key.
 * The token is refreshed automatically by `resolveGoogleOAuthCreds` before
 * each session.
 *
 * Pricing is the same as the api-key Gemini definition (free tier models
 * plus pay-as-you-go for Pro).
 */
export const googleOAuth = defineProvider({
  kind: 'google-oauth',
  displayName: 'Google (OAuth)',
  credKind: 'oauth',
  envVars: [],
  /**
   * Default models mirror the VALID_GEMINI_MODELS allowlist from gemini-cli.
   * Includes stable (2.x) + preview (3.x) models.
   */
  defaultModels: [
    // Stable
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
    // Preview (3.x)
    'gemini-3-pro-preview',
    'gemini-3.1-pro-preview',
    'gemini-3.1-pro-preview-customtools',
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite-preview',
  ],
  pricing: {
    // Stable
    'gemini-2.5-pro':        { inputPer1M: 1.25, outputPer1M: 10.00 },
    'gemini-2.5-flash':      { inputPer1M: 0.00, outputPer1M: 0.00 },
    'gemini-2.5-flash-lite': { inputPer1M: 0.00, outputPer1M: 0.00 },
    'gemini-2.0-flash':      { inputPer1M: 0.00, outputPer1M: 0.00 },
    // Preview — pricing TBD, default to free
    'gemini-3-pro-preview':               { inputPer1M: 0.00, outputPer1M: 0.00 },
    'gemini-3.1-pro-preview':             { inputPer1M: 0.00, outputPer1M: 0.00 },
    'gemini-3.1-pro-preview-customtools': { inputPer1M: 0.00, outputPer1M: 0.00 },
    'gemini-3-flash-preview':             { inputPer1M: 0.00, outputPer1M: 0.00 },
    'gemini-3.1-flash-lite-preview':      { inputPer1M: 0.00, outputPer1M: 0.00 },
  },
  capabilities: { supportsThinking: true, supportsVision: true },
  createIndexer: (creds, model) =>
    new GeminiProvider(
      undefined, model,
      creds.apiKey,                                          // accessToken
      creds.extra?.refreshToken as string | undefined,       // refreshToken
      creds.extra?.projectId as string | undefined,          // projectId
    ),
  createCoder: (creds, model, opts) =>
    new GeminiChatProvider({
      accessToken: creds.apiKey,
      refreshToken: creds.extra?.refreshToken as string | undefined,
      projectId: creds.extra?.projectId as string | undefined,
      cloudCodeSessionId: opts?.cloudCodeSessionId,
      model: model ?? 'gemini-2.5-flash',
    }),
});
