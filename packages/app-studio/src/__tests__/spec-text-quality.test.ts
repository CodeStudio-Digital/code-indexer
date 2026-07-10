import { describe, expect, it } from 'vitest';
import { prepareSpecSave } from '../spec/save-core.js';
import { repairMojibakeText } from '../spec/text-quality.js';
import { makeSpec } from './fixtures.js';

describe('spec text quality', () => {
  it('repairs recoverable UTF-8 mojibake before saving the spec', () => {
    const prepared = prepareSpecSave(
      makeSpec({
        summary: 'Gerencia competi\u00C3\u00A7\u00C3\u00B5es e finan\u00C3\u00A7as',
        audience: 'F\u00C3\u00A3s de futebol',
        features: [
          {
            id: 'gestao-competicoes',
            name: 'Gest\u00C3\u00A3o de competi\u00C3\u00A7\u00C3\u00B5es',
            description: 'Acompanhar partidas, tabelas e pr\u00C3\u00B3ximos jogos',
            screen_ids: ['painel'],
          },
        ],
        requirements: {
          acceptance_criteria: ['O painel mostra o pr\u00C3\u00B3ximo jogo e not\u00C3\u00ADcias recentes'],
        },
        design: { tone: 'limpo e amig\u00C3\u00A1vel' },
      }),
      null,
    );

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.issues.join('\n'));
    expect(prepared.spec.summary).toBe('Gerencia competi\u00E7\u00F5es e finan\u00E7as');
    expect(prepared.spec.audience).toBe('F\u00E3s de futebol');
    expect(prepared.spec.features[0]?.name).toBe('Gest\u00E3o de competi\u00E7\u00F5es');
    expect(prepared.spec.requirements?.acceptance_criteria?.[0]).toContain('pr\u00F3ximo jogo');
    expect(prepared.mirrorJson).toContain('competi\u00E7\u00F5es');
    expect(prepared.mirrorJson).not.toContain('\u00C3\u00A7');
  });

  it('repairs Windows-1252 mojibake punctuation locally without damaging valid accents', () => {
    expect(repairMojibakeText('Gest\u00C3\u00A3o: usu\u00E1rio clica em \u00E2\u20AC\u0153Salvar\u00E2\u20AC\u009D')).toBe(
      'Gest\u00E3o: usu\u00E1rio clica em \u201CSalvar\u201D',
    );
  });

  it('rejects unrecoverable replacement characters instead of persisting corrupted spec text', () => {
    const prepared = prepareSpecSave(
      makeSpec({
        summary: 'Gerencia competi\uFFFD\uFFFD\uFFFD\uFFFDes e finan\uFFFD\uFFFDas',
        requirements: {
          goals: ['Escalar titulares antes de cada partida em uma forma\uFFFD\uFFFDo v\u00E1lida'],
        },
      }),
      null,
    );

    expect(prepared.ok).toBe(false);
    if (prepared.ok) throw new Error('Expected corrupted text to be rejected');
    expect(prepared.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('summary: contains Unicode replacement characters'),
        expect.stringContaining('requirements.goals[0]: contains Unicode replacement characters'),
      ]),
    );
  });
});
