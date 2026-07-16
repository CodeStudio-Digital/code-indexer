import { describe, expect, it } from 'vitest';
import { structuralPathFlags } from '../mapper.js';

describe('structuralPathFlags', () => {
  it('classifies entrypoints, tests and generated files deterministically', () => {
    expect(structuralPathFlags('src/server.ts')).toMatchObject({ isEntryPoint: true });
    expect(structuralPathFlags('src/__tests__/auth.ts')).toMatchObject({ isTest: true });
    expect(structuralPathFlags('src/auth.spec.ts')).toMatchObject({ isTest: true });
    expect(structuralPathFlags('generated/client.ts')).toMatchObject({ isGenerated: true });
    expect(structuralPathFlags('src/client.g.ts')).toMatchObject({ isGenerated: true });
    expect(structuralPathFlags('src/client.generated.ts')).toMatchObject({ isGenerated: true });
    expect(structuralPathFlags('src/service.ts')).toEqual({
      isEntryPoint: false,
      isTest: false,
      isGenerated: false,
    });
  });
});
