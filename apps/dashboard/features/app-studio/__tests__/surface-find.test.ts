import { describe, expect, it } from 'vitest';
import { findTextMatchOffsets } from '../AppStudioSurfaceFind.js';

describe('App Studio surface find', () => {
  it('finds every case-insensitive occurrence', () => {
    expect(findTextMatchOffsets('Plano, plano e PLANO aprovado.', 'plano', false)).toEqual([0, 7, 15]);
  });

  it('supports case-sensitive matching and empty queries', () => {
    expect(findTextMatchOffsets('Dados dados DADOS', 'Dados', true)).toEqual([0]);
    expect(findTextMatchOffsets('Dados dados DADOS', 'dados', true)).toEqual([6]);
    expect(findTextMatchOffsets('Dados', '   ', false)).toEqual([]);
  });
});
