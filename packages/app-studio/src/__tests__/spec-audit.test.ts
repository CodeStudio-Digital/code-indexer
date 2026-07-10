import { describe, expect, it } from 'vitest';
import { auditAppSpec } from '../spec/audit.js';
import { makeSpec } from './fixtures.js';

describe('auditAppSpec', () => {
  it('flags missing requirements, behavior, and relationship hints', () => {
    const report = auditAppSpec(makeSpec({
      features: [
        { id: 'gestao-pedidos', name: 'Gestao de pedidos', description: 'criar pedidos', screen_ids: [] },
      ],
      database: {
        required: true,
        entities: [
          {
            name: 'pedidos',
            label: 'Pedidos',
            fields: [
              { name: 'cliente_id', label: 'Cliente', type: 'integer' },
            ],
          },
        ],
      },
    }));

    expect(report.score).toBeLessThan(100);
    expect(report.counts.warning).toBeGreaterThan(0);
    expect(report.issues.map((i) => i.id)).toEqual(
      expect.arrayContaining([
        'requirements-missing',
        'feature-gestao-pedidos-no-screen',
        'field-pedidos-cliente_id-missing-reference',
        'behaviors-missing',
      ]),
    );
  });

  it('rewards a refined spec with requirements and flow actions', () => {
    const report = auditAppSpec(makeSpec({
      requirements: {
        goals: ['Acompanhar pedidos sem planilhas'],
        acceptance_criteria: ['Criar um pedido com cliente e total'],
        business_rules: ['Pedido novo começa aberto'],
        out_of_scope: ['Integracao com delivery'],
      },
      behaviors: [
        {
          id: 'salvar-pedido',
          screen_id: 'painel',
          trigger: 'submit',
          trigger_label: 'ao enviar o formulario de pedido',
          actions: [
            { kind: 'save', entity: 'pedidos' },
            { kind: 'notify', message: 'Pedido salvo' },
          ],
        },
      ],
    }));

    expect(report.counts.error).toBe(0);
    expect(report.issues.map((i) => i.id)).not.toContain('requirements-missing');
    expect(report.score).toBeGreaterThanOrEqual(80);
  });
});
