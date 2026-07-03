/**
 * Onda 3a (Codex-parity): request provenance (`clientInfo`) on ApiContext.
 * createContext threads it through; createInternalContext marks 'internal'.
 */
import { describe, it, expect } from 'vitest';
import { createContext, createInternalContext } from '../context.js';

describe('createContext — clientInfo provenance', () => {
  it('threads clientInfo through', () => {
    const ctx = createContext({ clientInfo: { sourceType: 'electron', origin: 'coder.stream' } });
    expect(ctx.clientInfo).toEqual({ sourceType: 'electron', origin: 'coder.stream' });
    expect(typeof ctx.requestId).toBe('string');
  });

  it('leaves clientInfo undefined when not supplied', () => {
    expect(createContext().clientInfo).toBeUndefined();
  });

  it('marks internal callers as sourceType "internal"', () => {
    expect(createInternalContext().clientInfo).toEqual({ sourceType: 'internal' });
  });
});
