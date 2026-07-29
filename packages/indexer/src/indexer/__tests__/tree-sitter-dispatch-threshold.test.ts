import { afterEach, describe, expect, it } from 'vitest';
import { resolveTreeSitterPoolMinBytes } from '../tree-sitter-dispatch.js';

const KEY = 'MCP_INDEX_POOL_MIN_BYTES';
const previous = process.env[KEY];

afterEach(() => {
  if (previous === undefined) delete process.env[KEY];
  else process.env[KEY] = previous;
});

describe('tree-sitter hybrid pool threshold', () => {
  it('keeps small files local by default', () => {
    delete process.env[KEY];
    expect(resolveTreeSitterPoolMinBytes()).toBe(16 * 1024);
  });

  it('accepts zero to force every parse through the pool', () => {
    process.env[KEY] = '0';
    expect(resolveTreeSitterPoolMinBytes()).toBe(0);
  });

  it('falls back for invalid values', () => {
    process.env[KEY] = 'not-a-size';
    expect(resolveTreeSitterPoolMinBytes()).toBe(16 * 1024);
  });
});
