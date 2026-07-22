import { describe, expect, it } from 'vitest';
import { serverById } from '@mcp/services/lsp/server-registry.js';
import { shouldWarmLspStatus } from '../lsp-status-policy.js';

describe('shouldWarmLspStatus', () => {
  const server = serverById('intelephense')!;

  it('does not warm a compatibility fallback without file context', () => {
    expect(shouldWarmLspStatus(undefined, { state: 'idle', server })).toBe(false);
  });

  it('warms an idle server after file-scoped routing', () => {
    expect(shouldWarmLspStatus('src/app.ts', { state: 'idle', server })).toBe(true);
  });
});
