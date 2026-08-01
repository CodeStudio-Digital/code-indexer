import { describe, expect, it } from 'vitest';
import { buildRendererCsp } from '../security-csp.js';

describe('buildRendererCsp', () => {
  it('authorizes the per-launch plugin nonce without enabling arbitrary inline scripts', () => {
    const policy = buildRendererCsp('abc123+/=');

    expect(policy).toContain(
      "script-src 'self' 'wasm-unsafe-eval' 'nonce-abc123+/='",
    );
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});
