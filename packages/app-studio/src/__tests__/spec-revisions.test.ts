import { describe, expect, it } from 'vitest';
import { diffAppSpecs, impactFromSpecDiff, parseAppSpecImpact, summarizeSpecDiff } from '../spec/revisions.js';
import { makeSpec } from './fixtures.js';
import { upgradeAppSpecToV2 } from '../spec/stable-ids.js';

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
    expect(impact.affected_phases).toEqual(['define', 'blueprint', 'build', 'deliver']);
    expect(impact.source_ids).toContain('entity:clientes');
    expect(impact.source_ids).not.toContain('entity:pedidos');
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
    expect(impact.affected_phases).toEqual(['define', 'blueprint', 'build', 'deliver']);
    expect(impact.source_ids).toContain('screen:relatorios');
    expect(impact.source_ids).not.toContain('screen:painel');
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

    expect(impactFromSpecDiff(diff)).toMatchObject({ level: 'medium', affected_phases: ['define', 'blueprint', 'build', 'deliver'] });
    expect(summarizeSpecDiff(diff)).toContain('Requisitos, regras ou criterios de aceite atualizados.');
  });

  it('invalidates the exact stable requirement source instead of every requirement', () => {
    const base = upgradeAppSpecToV2(makeSpec({ requirements: {
      goals: ['Track orders'],
      acceptance_criteria: ['Order can be saved', 'Order can be listed'],
    } }));
    const next = { ...base, requirements: { ...base.requirements, acceptance_criteria: ['Order saves with a customer', 'Order can be listed'] } };
    const ids = base.requirement_ids?.acceptance ?? [];
    const impact = impactFromSpecDiff(diffAppSpecs(base, next));
    expect(impact.source_ids).toContain(ids[0]);
    expect(impact.source_ids).not.toContain(ids[1]);
  });

  it('normalizes canonical persisted impacts and rejects malformed payloads', () => {
    expect(parseAppSpecImpact(JSON.stringify({
      level: 'high',
      affected_phases: ['deliver', 'blueprint', 'invalid', 'blueprint'],
      source_ids: ['screen:home', 'screen:home', null],
      reasons: ['Changed scope'],
    }))).toEqual({
      level: 'high',
      affected_phases: ['blueprint', 'deliver'],
      source_ids: ['screen:home'],
      reasons: ['Changed scope'],
    });
    expect(parseAppSpecImpact('{not-json')).toBeNull();
    expect(parseAppSpecImpact({ level: 'high', stage_ids: ['architecture'] })).toEqual({
      level: 'high', affected_phases: [], source_ids: [], reasons: [],
    });
  });
});
