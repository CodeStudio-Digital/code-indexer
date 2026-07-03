import type { ProviderSpec } from '@mcp/provider-sdk';

/**
 * Google Gemini via OAuth — same native adapter as the api-key `gemini`, but the
 * resolved token routes through the CloudCode backend (accessToken/refreshToken/
 * projectId). The OAuth flow + live discovery are provider-specific.
 */
export const googleOAuthSpec: ProviderSpec = {
  kind: 'google-oauth',
  displayName: 'Google (OAuth)',
  visual: { icon: 'Globe', fg: 'text-blue-500', bg: 'bg-blue-500/15' },
  credKind: 'oauth',
  envVars: [],
  defaultModels: [
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
    'gemini-3-pro-preview',
    'gemini-3.1-pro-preview',
    'gemini-3.1-pro-preview-customtools',
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite-preview',
  ],
  pricing: {
    'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10.0 },
    'gemini-2.5-flash': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'gemini-2.5-flash-lite': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'gemini-2.0-flash': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'gemini-3-pro-preview': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'gemini-3.1-pro-preview': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'gemini-3.1-pro-preview-customtools': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'gemini-3-flash-preview': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'gemini-3.1-flash-lite-preview': { inputPer1M: 0.0, outputPer1M: 0.0 },
  },
  capabilities: { supportsThinking: true, supportsVision: true },
  wire: 'gemini',
  wireOpts: { geminiOAuth: true },
  discovery: { from: 'sdk:google-oauth' },
  test: { from: 'gemini-oauth' },
  // Declarative OAuth (authorization-code + loopback :1456 + PKCE) WITH a public
  // client_secret (gemini-cli's, Apache-2.0). Values inlined from
  // services/oauth/google.ts (parity-tested). The 'google' hook owns projectId
  // resolution via CloudCode.
  auth: {
    mode: 'oauth',
    flavor: 'authorization-code',
    scopes: [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
    refreshThresholdSec: 60,
    needs: { loopback: true, openBrowser: true, scheduledRefresh: true },
    clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
    clientSecret: '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',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    redirect: { port: 1456, path: '/auth/callback' },
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
    hooks: 'google-oauth',
  },
};

export const GOOGLE_OAUTH_SPECS: ProviderSpec[] = [googleOAuthSpec];
