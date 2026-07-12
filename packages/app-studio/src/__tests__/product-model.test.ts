import { describe, expect, it } from 'vitest';
import { auditAppProductModel } from '../product/audit.js';
import { classifyProductComplexity, recoverProductModel } from '../product/recover.js';
import { makeSpec } from './fixtures.js';

describe('product modeling', () => {
  it('classifies complex stateful products and keeps inferred expansion unselected', () => {
    const spec = makeSpec({
      summary: 'Jogo multiplayer de futebol ao vivo com contratos, finanças e reconexão',
      features: [
        { id: 'partida', name: 'Partida ao vivo', description: 'Dois técnicos jogam simultaneamente', screen_ids: ['painel'] },
      ],
      database: { required: true, entities: Array.from({ length: 31 }, (_, index) => ({ name: `entity_${index}`, label: `Entity ${index}`, fields: [{ name: 'nome', label: 'Nome', type: 'text' as const }] })) },
    });
    expect(classifyProductComplexity(spec).complexity).toBe('very-complex');
    const model = recoverProductModel(spec, 10);
    expect(model.capabilities.some((item) => item.id === 'proposed-training' && !item.selected && item.horizon === 'complete')).toBe(true);
    expect(model.decisions).toContainEqual(expect.objectContaining({ id: 'scope-depth', status: 'open', blocking: true }));
  });

  it('requires semantic scenarios and explicit research provenance', () => {
    const model = recoverProductModel(makeSpec(), 10);
    model.decisions = [];
    const capability = model.capabilities[0]!;
    capability.critical = true;
    capability.provenance = 'researched';
    capability.research_source_ids = [];
    model.scenarios = model.scenarios.filter((item) => item.kind === 'success');
    const report = auditAppProductModel(model);
    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('without a source'),
      expect.stringContaining("needs a 'permission' scenario"),
      expect.stringContaining("needs a 'state-transition' scenario"),
    ]));
  });

  it('accepts a complete simple model', () => {
    const model = recoverProductModel(makeSpec(), 10);
    model.decisions = [];
    expect(auditAppProductModel(model).ok).toBe(true);
  });
});
