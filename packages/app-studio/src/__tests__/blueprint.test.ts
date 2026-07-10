import { describe, expect, it } from 'vitest';
import { calculateBlueprintAutoLayout, specToGraph } from '../blueprint/spec-to-graph.js';
import { applySpecMutation, type BlueprintMutation } from '../blueprint/mutations.js';
import { diffSpec, formatDiffSummary } from '../blueprint/diff-summary.js';
import { nodeIds } from '../blueprint/types.js';
import { validateAppSpec } from '../spec/validate.js';
import type { AppSpec } from '../spec/types.js';
import { makeSpec } from './fixtures.js';

/** Spec rica: 2 telas, 2 entities (com FK), auth protegendo, 1 behavior. */
function richSpec(): AppSpec {
  const spec = makeSpec({
    screens: [
      { id: 'painel', name: 'PainelScreen', label: 'Painel', purpose: 'ver pedidos', primary: true },
      { id: 'clientes', name: 'ClientesScreen', label: 'Clientes', purpose: 'gerir clientes' },
    ],
    auth: { enabled: true, methods: ['password'], protected_screen_ids: ['clientes'] },
  });
  spec.database.entities.push({
    name: 'clientes',
    label: 'Clientes',
    fields: [
      { name: 'id', label: 'Id', type: 'integer' },
      { name: 'nome', label: 'Nome', type: 'text' },
    ],
  });
  spec.database.entities[0].fields.push({ name: 'clientes_id', label: 'Cliente', type: 'integer', references: 'clientes' });
  spec.behaviors = [
    {
      id: 'salvar-pedido',
      screen_id: 'painel',
      trigger: 'submit',
      trigger_label: 'ao enviar o pedido',
      actions: [
        { kind: 'save', entity: 'pedidos' },
        { kind: 'navigate', screen_id: 'clientes' },
      ],
    },
  ];
  return spec;
}

describe('specToGraph', () => {
  it('derives nodes and edges with stable ids', () => {
    const g = specToGraph(richSpec());
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain('screen:painel');
    expect(ids).toContain('entity:clientes');
    expect(ids).toContain('feature:gestao-pedidos');
    expect(ids).toContain('auth');
    expect(ids).toContain('behavior:salvar-pedido');
    const kinds = g.edges.map((e) => `${e.kind}:${e.source}->${e.target}`);
    expect(kinds).toContain('feature-screen:feature:gestao-pedidos->screen:painel');
    expect(kinds).toContain('entity-ref:entity:pedidos->entity:clientes');
    expect(kinds).toContain('auth-screen:auth->screen:clientes');
    expect(kinds).toContain('screen-behavior:screen:painel->behavior:salvar-pedido');
    expect(kinds).toContain('behavior-target:behavior:salvar-pedido->entity:pedidos');
    expect(kinds).toContain('behavior-target:behavior:salvar-pedido->screen:clientes');
  });

  it('saved layout positions win over auto-layout', () => {
    const layout = { v: 1 as const, positions: { [nodeIds.screen('painel')]: { x: 999, y: 42 } } };
    const g = specToGraph(richSpec(), layout);
    expect(g.nodes.find((n) => n.id === 'screen:painel')!.position).toEqual({ x: 999, y: 42 });
    // Nó sem posição salva usa a coluna default.
    expect(g.nodes.find((n) => n.id === 'entity:pedidos')!.position.x).toBe(940);
  });

  it('orders screens by the navigation journey starting at a root screen', () => {
    const spec = richSpec();
    spec.screens = [
      { id: 'relatorios', name: 'RelatoriosScreen', label: 'Relatorios', purpose: 'ver resultados' },
      ...spec.screens,
    ];
    spec.behaviors!.push({
      id: 'abrir-relatorios',
      screen_id: 'clientes',
      trigger: 'click',
      trigger_label: 'ao abrir relatorios',
      actions: [{ kind: 'navigate', screen_id: 'relatorios' }],
    });

    const positions = calculateBlueprintAutoLayout(spec);
    expect(positions['screen:painel'].y).toBeLessThan(positions['screen:clientes'].y);
    expect(positions['screen:clientes'].y).toBeLessThan(positions['screen:relatorios'].y);
  });

  it('keeps behaviors beside their source screen and packs data cards tightly', () => {
    const positions = calculateBlueprintAutoLayout(richSpec());
    const behaviorY = positions['behavior:salvar-pedido'].y;
    const sourceScreenY = positions['screen:painel'].y;
    const nextScreenY = positions['screen:clientes'].y;
    const entityGap = positions['entity:clientes'].y - positions['entity:pedidos'].y;

    expect(behaviorY).toBeLessThan(nextScreenY);
    expect(Math.abs(behaviorY - sourceScreenY)).toBeLessThan(40);
    expect(entityGap).toBeGreaterThanOrEqual(100);
    expect(entityGap).toBeLessThan(160);
  });

  it('spreads large data models across adaptive columns', () => {
    const spec = richSpec();
    for (let index = 0; index < 19; index += 1) {
      spec.database.entities.push({
        name: `extra_${index}`,
        label: `Extra ${index}`,
        fields: [{ name: 'nome', label: 'Nome', type: 'text' }],
      });
    }

    const positions = calculateBlueprintAutoLayout(spec);
    const entityPositions = Object.entries(positions)
      .filter(([id]) => id.startsWith('entity:'))
      .map(([, position]) => position);

    expect(new Set(entityPositions.map((position) => position.x)).size).toBe(3);
    expect(Math.max(...entityPositions.map((position) => position.y))).toBeLessThan(1_000);
  });

  it('drops dangling edges instead of rendering them', () => {
    const spec = richSpec();
    spec.behaviors![0].actions.push({ kind: 'navigate', screen_id: 'fantasma' } as never);
    const g = specToGraph(spec);
    expect(g.edges.every((e) => g.nodes.some((n) => n.id === e.target))).toBe(true);
  });
});

describe('applySpecMutation — invariante: spec válida permanece válida', () => {
  const MUTATIONS: BlueprintMutation[] = [
    { op: 'add-screen', label: 'Relatórios' },
    { op: 'update-screen', screen_id: 'painel', patch: { label: 'Painel novo' } },
    { op: 'remove-screen', screen_id: 'clientes' },
    { op: 'add-feature', name: 'Exportação' },
    { op: 'connect-feature-screen', feature_id: 'gestao-pedidos', screen_id: 'clientes' },
    { op: 'disconnect-feature-screen', feature_id: 'gestao-pedidos', screen_id: 'painel' },
    { op: 'set-auth-enabled', enabled: false },
    { op: 'protect-screen', screen_id: 'painel' },
    { op: 'add-entity', label: 'Produtos' },
    { op: 'remove-entity', entity: 'clientes' },
    { op: 'add-field', entity: 'pedidos', label: 'Observação' },
    { op: 'update-field', entity: 'pedidos', field: 'total', patch: { name: 'valor_total', label: 'Valor total', required: true } },
    { op: 'remove-field', entity: 'pedidos', field: 'total' },
    { op: 'set-field-reference', entity: 'clientes', target: 'pedidos' },
    { op: 'update-field', entity: 'pedidos', field: 'clientes_id', patch: { references: null } },
    { op: 'add-behavior', screen_id: 'painel', trigger: 'click', trigger_label: 'ao clicar em novo', action: { kind: 'notify', message: 'ok' } },
    { op: 'remove-behavior', behavior_id: 'salvar-pedido' },
    { op: 'remove-behavior-action', behavior_id: 'salvar-pedido', index: 0 },
  ];

  for (const m of MUTATIONS) {
    it(`'${m.op}' keeps the spec valid`, () => {
      const { spec } = applySpecMutation(richSpec(), m);
      expect(validateAppSpec(spec)).toEqual([]);
    });
  }

  it('is immutable (input untouched)', () => {
    const input = richSpec();
    const snapshot = JSON.stringify(input);
    applySpecMutation(input, { op: 'remove-screen', screen_id: 'clientes' });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('remove-screen cascades and reports (features, auth, behaviors, primary)', () => {
    const spec = richSpec();
    spec.features[0].screen_ids = ['painel', 'clientes'];
    const { spec: next, cascaded } = applySpecMutation(spec, { op: 'remove-screen', screen_id: 'painel' });
    expect(next.screens.map((s) => s.id)).toEqual(['clientes']);
    expect(next.screens[0].primary).toBe(true); // promovida
    expect(next.behaviors ?? []).toHaveLength(0); // behavior era da tela
    expect(cascaded.join('\n')).toContain('desconectada');
    expect(validateAppSpec(next)).toEqual([]);
  });

  it('remove-entity clears FKs and save-actions (reported)', () => {
    const { spec: next, cascaded } = applySpecMutation(richSpec(), { op: 'remove-entity', entity: 'pedidos' });
    const clientes = next.database.entities.find((e) => e.name === 'clientes')!;
    expect(clientes.fields.every((f) => f.references !== 'pedidos')).toBe(true);
    // behavior 'salvar-pedido' salvava em pedidos → ação removida, sobra navigate.
    expect(next.behaviors![0].actions).toEqual([{ kind: 'navigate', screen_id: 'clientes' }]);
    expect(cascaded.length).toBeGreaterThan(0);
    expect(validateAppSpec(next)).toEqual([]);
  });

  it('set-field-reference creates the FK field when missing', () => {
    const { spec: next, cascaded } = applySpecMutation(richSpec(), { op: 'set-field-reference', entity: 'clientes', target: 'pedidos' });
    const clientes = next.database.entities.find((e) => e.name === 'clientes')!;
    const fk = clientes.fields.find((f) => f.name === 'pedidos_id')!;
    expect(fk).toMatchObject({ type: 'integer', references: 'pedidos' });
    expect(cascaded.join()).toContain('pedidos_id');
  });

  it('set-field-reference can create a manually named FK field', () => {
    const { spec: next } = applySpecMutation(richSpec(), {
      op: 'set-field-reference',
      entity: 'pedidos',
      target: 'clientes',
      field: 'cliente_principal_id',
      label: 'Cliente principal',
    });
    const pedidos = next.database.entities.find((e) => e.name === 'pedidos')!;
    expect(pedidos.fields.find((f) => f.name === 'cliente_principal_id')).toMatchObject({
      label: 'Cliente principal',
      type: 'integer',
      references: 'clientes',
    });
    expect(validateAppSpec(next)).toEqual([]);
  });

  it('set-field-reference can convert an existing field into a FK', () => {
    const { spec: next } = applySpecMutation(richSpec(), {
      op: 'set-field-reference',
      entity: 'clientes',
      target: 'pedidos',
      field: 'id',
    });
    const clientes = next.database.entities.find((e) => e.name === 'clientes')!;
    expect(clientes.fields.find((f) => f.name === 'id')).toMatchObject({ type: 'integer', references: 'pedidos' });
    expect(validateAppSpec(next)).toEqual([]);
  });

  it('update-field clears FK references without deleting the field', () => {
    const { spec: next } = applySpecMutation(richSpec(), {
      op: 'update-field',
      entity: 'pedidos',
      field: 'clientes_id',
      patch: { references: null },
    });
    const pedidos = next.database.entities.find((e) => e.name === 'pedidos')!;
    const field = pedidos.fields.find((f) => f.name === 'clientes_id')!;
    expect(field.references).toBeUndefined();
    expect(field.type).toBe('integer');
    expect(validateAppSpec(next)).toEqual([]);
  });

  it('throws on unknown refs', () => {
    expect(() => applySpecMutation(richSpec(), { op: 'remove-screen', screen_id: 'nope' })).toThrow("Unknown screen 'nope'");
    expect(() => applySpecMutation(richSpec(), { op: 'remove-entity', entity: 'nope' })).toThrow("Unknown entity 'nope'");
  });
});

describe('diffSpec', () => {
  it('reports added/removed/changed entries', () => {
    const before = richSpec();
    let after = applySpecMutation(before, { op: 'add-screen', label: 'Relatórios' }).spec;
    after = applySpecMutation(after, { op: 'remove-entity', entity: 'clientes' }).spec;
    after = applySpecMutation(after, { op: 'update-feature', feature_id: 'gestao-pedidos', patch: { name: 'Pedidos 2' } }).spec;
    const entries = diffSpec(before, after);
    const text = formatDiffSummary(entries);
    expect(text).toContain("+ screen 'Relatórios'");
    expect(text).toContain("- entity 'Clientes'");
    expect(text).toContain("~ feature 'Pedidos 2'");
  });
});
