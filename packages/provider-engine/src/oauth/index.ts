/**
 * @mcp/provider-engine/oauth — the generic RFC OAuth engine driven by
 * `spec.auth` (AuthDescriptor). Covers the RFC 6749/7636 80-90% (PKCE,
 * authorize-URL, authorization_code exchange, refresh_token grant); the exotic
 * per-provider remainder (account-id-from-JWT, projectId, the kimi/copilot/
 * claude-code refresh) lives in host hooks keyed by provider kind.
 *
 * NOT re-exported from the package barrel — imported via the leaf subpath by the
 * generic OAuth routes (http-api) + the resolver, so node:http/crypto don't
 * leak into the registry/spec consumers.
 */
export * from './pkce.js';
export * from './authorize.js';
export * from './token.js';
