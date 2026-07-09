/**
 * Derivação PURA spec → grafo Blueprint. O grafo nunca é fonte de verdade:
 * toda edição vira mutação na spec e o grafo é re-derivado. Auto-layout em
 * colunas por kind (padrão ExecutionMapGraph); posição do layout salvo
 * sempre vence a calculada.
 */
import type { AppSpec } from '../spec/types.js';
import { nodeIds, type BlueprintEdge, type BlueprintGraph, type BlueprintLayout, type BlueprintNode, type BlueprintPosition } from './types.js';

// Colunas do auto-layout (x) + espaçamento vertical (y) por altura típica do nó.
const COL = { feature: 0, screen: 300, behavior: 620, entity: 940 } as const;
const ROW_GAP = { feature: 110, screen: 130, behavior: 150, entity: 220 } as const;

export function specToGraph(spec: AppSpec, layout?: BlueprintLayout | null): BlueprintGraph {
  const nodes: BlueprintNode[] = [];
  const edges: BlueprintEdge[] = [];
  const pos = (id: string, fallback: BlueprintPosition): BlueprintPosition =>
    layout?.positions[id] ?? fallback;

  const protectedIds = new Set(spec.auth.protected_screen_ids ?? []);

  spec.features.forEach((f, i) => {
    const id = nodeIds.feature(f.id);
    nodes.push({
      id,
      type: 'feature',
      position: pos(id, { x: COL.feature, y: i * ROW_GAP.feature }),
      data: { kind: 'feature', featureId: f.id, label: f.name, description: f.description },
    });
    for (const screenId of f.screen_ids) {
      edges.push({
        id: `e:feature:${f.id}:${screenId}`,
        source: id,
        target: nodeIds.screen(screenId),
        kind: 'feature-screen',
      });
    }
  });

  spec.screens.forEach((s, i) => {
    const id = nodeIds.screen(s.id);
    nodes.push({
      id,
      type: 'screen',
      position: pos(id, { x: COL.screen, y: i * ROW_GAP.screen }),
      data: {
        kind: 'screen',
        screenId: s.id,
        label: s.label,
        purpose: s.purpose,
        primary: s.primary === true,
        protected: protectedIds.has(s.id),
      },
    });
  });

  (spec.behaviors ?? []).forEach((b, i) => {
    const id = nodeIds.behavior(b.id);
    nodes.push({
      id,
      type: 'behavior',
      position: pos(id, { x: COL.behavior, y: i * ROW_GAP.behavior }),
      data: {
        kind: 'behavior',
        behaviorId: b.id,
        screenId: b.screen_id,
        trigger: b.trigger,
        label: b.trigger_label,
        actions: b.actions,
      },
    });
    edges.push({
      id: `e:screen:${b.screen_id}:behavior:${b.id}`,
      source: nodeIds.screen(b.screen_id),
      target: id,
      kind: 'screen-behavior',
      label: b.trigger,
    });
    b.actions.forEach((a, j) => {
      if (a.kind === 'save') {
        edges.push({
          id: `e:behavior:${b.id}:save:${j}`,
          source: id,
          target: nodeIds.entity(a.entity),
          kind: 'behavior-target',
          label: 'save',
        });
      } else if (a.kind === 'navigate') {
        edges.push({
          id: `e:behavior:${b.id}:nav:${j}`,
          source: id,
          target: nodeIds.screen(a.screen_id),
          kind: 'behavior-target',
          label: 'navigate',
        });
      }
    });
  });

  spec.database.entities.forEach((e, i) => {
    const id = nodeIds.entity(e.name);
    nodes.push({
      id,
      type: 'entity',
      position: pos(id, { x: COL.entity, y: i * ROW_GAP.entity }),
      data: {
        kind: 'entity',
        entityName: e.name,
        label: e.label,
        fields: e.fields.map((f) => ({
          name: f.name,
          label: f.label,
          type: f.type,
          ...(f.references ? { references: f.references } : {}),
        })),
      },
    });
    for (const f of e.fields) {
      if (f.references) {
        edges.push({
          id: `e:entity:${e.name}:${f.name}`,
          source: id,
          target: nodeIds.entity(f.references),
          kind: 'entity-ref',
          label: f.name,
        });
      }
    }
  });

  if (spec.auth.enabled) {
    const authY = spec.features.length * ROW_GAP.feature + 40;
    nodes.push({
      id: nodeIds.auth,
      type: 'auth',
      position: pos(nodeIds.auth, { x: COL.feature, y: authY }),
      data: { kind: 'auth', enabled: true, methods: spec.auth.methods ?? [] },
    });
    for (const screenId of protectedIds) {
      edges.push({
        id: `e:auth:${screenId}`,
        source: nodeIds.auth,
        target: nodeIds.screen(screenId),
        kind: 'auth-screen',
      });
    }
  }

  // Edges cujo alvo não existe (spec em transição) são descartadas — o
  // canvas nunca renderiza aresta pendurada.
  const known = new Set(nodes.map((n) => n.id));
  return { nodes, edges: edges.filter((e) => known.has(e.source) && known.has(e.target)) };
}
