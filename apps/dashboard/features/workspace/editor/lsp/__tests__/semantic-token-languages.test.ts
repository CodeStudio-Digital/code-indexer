import { describe, expect, it } from 'vitest';
import { SEMANTIC_TOKEN_LANGS } from '../navigation.js';

describe('semantic token languages', () => {
  it('requests semantic classifications for Java and C#', () => {
    expect(SEMANTIC_TOKEN_LANGS).toContain('java');
    expect(SEMANTIC_TOKEN_LANGS).toContain('csharp');
  });
});
