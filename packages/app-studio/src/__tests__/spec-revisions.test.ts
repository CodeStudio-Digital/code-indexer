import { describe, expect, it } from 'vitest';
import { diffAppSpecs, impactFromSpecDiff, summarizeSpecDiff } from '../spec/revisions.js';
import { makeSpec } from './fixtures.js';

describe('spec revision diff and impact', () => {
  it('detects database changes as high impact from database onward', () => {
    const base = makeSpec();
    const next = makeSpec({
      database: {
        required: true,
        entities: [
          ...base.database.entities,
          {
            name: 'clientes',
            label: 'Clientes',
            fields: [{ name: 'nome', label: 'Nome', type: 'text', required: true }],
          },
        ],
      },
    });

    const diff = diffAppSpecs(base, next);
    const impact = impactFromSpecDiff(diff);

    expect(diff.entities.added).toEqual(['Clientes']);
    expect(impact.level).toBe('high');
    expect(impact.stage_ids).toEqual(['architecture', 'database', 'backend', 'review']);
  });

  it('detects screen changes as design/backend/review impact', () => {
    const base = makeSpec();
    const next = makeSpec({
      screens: [
        ...base.screens,
        {
          id: 'relatorios',
          name: 'RelatoriosScreen',
          label: 'Relatorios',
          purpose: 'acompanhar resultados',
        },
      ],
    });

    const impact = impactFromSpecDiff(diffAppSpecs(base, next));

    expect(impact.level).toBe('medium');
    expect(impact.stage_ids).toEqual(['architecture', 'design', 'backend', 'review']);
  });

  it('summarizes requirements-only changes without forcing rebuild stages', () => {
    const base = makeSpec();
    const next = makeSpec({
      requirements: {
        goals: ['A dona acompanha pedidos sem planilha externa'],
        acceptance_criteria: ['Criar pedido com cliente e total'],
      },
    });

    const diff = diffAppSpecs(base, next);

    expect(impactFromSpecDiff(diff)).toMatchObject({ level: 'low', stage_ids: ['architecture', 'review'] });
    expect(summarizeSpecDiff(diff)).toContain('Requisitos, regras ou criterios de aceite atualizados.');
  });
});
