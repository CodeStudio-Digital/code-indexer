/**
 * Derivacao PURA spec -> grafo Blueprint. O grafo nunca e fonte de verdade:
 * toda edicao vira mutacao na spec e o grafo e re-derivado. O auto-layout
 * organiza pequenas faixas por tela e mantem a posicao salva como prioridade.
 */
import type { AppBehavior, AppSpec } from '../spec/types.js';
import {
  nodeIds,
  type BlueprintEdge,
  type BlueprintGraph,
  type BlueprintLayout,
  type BlueprintNode,
  type BlueprintPosition,
} from './types.js';

const COL = { feature: 0, screen: 300, behavior: 620, entity: 940 } as const;
const ITEM_GAP = 22;
const BEHAVIOR_GAP = 16;
const LANE_GAP = 30;
const ENTITY_COL_GAP = 280;

function nodeHeight(kind: 'feature' | 'screen' | 'auth', count?: number): number;
function nodeHeight(kind: 'behavior' | 'entity', count: number): number;
function nodeHeight(kind: 'feature' | 'screen' | 'auth' | 'behavior' | 'entity', count = 0): number {
  switch (kind) {
    case 'feature': return 70;
    case 'screen': return 86;
    case 'auth': return 70;
    case 'behavior': return 62 + Math.max(1, count) * 14;
    case 'entity': return 58 + Math.min(5, Math.max(1, count)) * 14;
  }
}

function average(values: number[], fallback: number): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
}

/**
 * Ordena telas como uma jornada: tela inicial primeiro e, em seguida, os
 * destinos de navegacao na ordem em que aparecem nos comportamentos.
 * Componentes desconectados preservam a ordem da spec.
 */
function orderScreens(spec: AppSpec): AppSpec['screens'] {
  const known = new Set(spec.screens.map((screen) => screen.id));
  const outgoing = new Map<string, string[]>();
  for (const behavior of spec.behaviors ?? []) {
    const targets = outgoing.get(behavior.screen_id) ?? [];
    for (const action of behavior.actions) {
      if (action.kind === 'navigate' && known.has(action.screen_id) && !targets.includes(action.screen_id)) {
        targets.push(action.screen_id);
      }
    }
    outgoing.set(behavior.screen_id, targets);
  }

  const byId = new Map(spec.screens.map((screen) => [screen.id, screen]));
  const ordered: AppSpec['screens'] = [];
  const seen = new Set<string>();
  const visit = (startId: string) => {
    const queue = [startId];
    seen.add(startId);
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const screen = byId.get(currentId);
      if (screen) ordered.push(screen);
      for (const targetId of outgoing.get(currentId) ?? []) {
        if (!seen.has(targetId)) {
          seen.add(targetId);
          queue.push(targetId);
        }
      }
    }
  };

  const navigationTargets = new Set([...outgoing.values()].flat());
  const roots = spec.screens.filter((screen) => !navigationTargets.has(screen.id));
  for (const root of roots) {
    if (!seen.has(root.id)) visit(root.id);
  }
  const primary = spec.screens.find((screen) => screen.primary) ?? spec.screens[0];
  if (primary && !seen.has(primary.id)) visit(primary.id);
  for (const screen of spec.screens) {
    if (!seen.has(screen.id)) visit(screen.id);
  }
  return ordered;
}

interface PackedItem {
  id: string;
  desired: number;
  height: number;
  order: number;
}

/** Compacta uma coluna mantendo a ordem relacional, sem criar grandes vazios. */
function packColumn(
  positions: Record<string, BlueprintPosition>,
  x: number,
  items: PackedItem[],
): void {
  const sorted = [...items].sort((a, b) => a.desired - b.desired || a.order - b.order);
  let y = 0;
  for (const item of sorted) {
    positions[item.id] = { x, y };
    y += item.height + ITEM_GAP;
  }
}

/**
 * Dados podem ser muito mais numerosos que telas e acoes. Acima de oito
 * entidades, distribui cards em uma grade alinhada de ate tres colunas para
 * impedir que esse unico tipo determine toda a altura do canvas.
 */
function packEntityGrid(
  positions: Record<string, BlueprintPosition>,
  items: PackedItem[],
): void {
  const columnCount = items.length > 18 ? 3 : items.length > 8 ? 2 : 1;
  const sorted = [...items].sort((a, b) => a.desired - b.desired || a.order - b.order);
  let y = 0;
  for (let start = 0; start < sorted.length; start += columnCount) {
    const row = sorted.slice(start, start + columnCount);
    row.forEach((item, column) => {
      positions[item.id] = { x: COL.entity + column * ENTITY_COL_GAP, y };
    });
    y += Math.max(...row.map((item) => item.height)) + ITEM_GAP;
  }
}

/**
 * Calcula o layout recomendado sem considerar posicoes persistidas. E publico
 * para o canvas poder oferecer o comando "organizar mapa".
 */
export function calculateBlueprintAutoLayout(spec: AppSpec): Record<string, BlueprintPosition> {
  const positions: Record<string, BlueprintPosition> = {};
  const screenCenters = new Map<string, number>();
  const behaviorCenters = new Map<string, number>();
  const behaviorsByScreen = new Map<string, AppBehavior[]>();

  for (const behavior of spec.behaviors ?? []) {
    const group = behaviorsByScreen.get(behavior.screen_id) ?? [];
    group.push(behavior);
    behaviorsByScreen.set(behavior.screen_id, group);
  }

  // Cada tela forma uma faixa com suas acoes. Assim o leitor percorre o mapa
  // horizontalmente sem precisar procurar o proximo passo muito abaixo.
  let laneY = 0;
  const placedBehaviors = new Set<string>();
  for (const screen of orderScreens(spec)) {
    const behaviors = behaviorsByScreen.get(screen.id) ?? [];
    const behaviorHeights = behaviors.map((behavior) => nodeHeight('behavior', behavior.actions.length));
    const behaviorStackHeight = behaviorHeights.reduce((sum, height) => sum + height, 0)
      + Math.max(0, behaviors.length - 1) * BEHAVIOR_GAP;
    const screenHeight = nodeHeight('screen');
    const laneHeight = Math.max(screenHeight, behaviorStackHeight);
    const screenY = laneY + (laneHeight - screenHeight) / 2;

    positions[nodeIds.screen(screen.id)] = { x: COL.screen, y: screenY };
    screenCenters.set(screen.id, screenY + screenHeight / 2);

    let behaviorY = laneY;
    behaviors.forEach((behavior, index) => {
      const height = behaviorHeights[index];
      positions[nodeIds.behavior(behavior.id)] = { x: COL.behavior, y: behaviorY };
      behaviorCenters.set(behavior.id, behaviorY + height / 2);
      placedBehaviors.add(behavior.id);
      behaviorY += height + BEHAVIOR_GAP;
    });
    laneY += laneHeight + LANE_GAP;
  }

  // Specs em transicao podem conter uma acao cuja tela ainda nao existe.
  for (const behavior of spec.behaviors ?? []) {
    if (placedBehaviors.has(behavior.id)) continue;
    const height = nodeHeight('behavior', behavior.actions.length);
    positions[nodeIds.behavior(behavior.id)] = { x: COL.behavior, y: laneY };
    behaviorCenters.set(behavior.id, laneY + height / 2);
    laneY += height + LANE_GAP;
  }

  const totalHeight = Math.max(laneY - LANE_GAP, nodeHeight('screen'));
  const fallbackCenter = (index: number, count: number) => ((index + 0.5) / Math.max(1, count)) * totalHeight;

  const sourceItems: PackedItem[] = spec.features.map((feature, index) => ({
    id: nodeIds.feature(feature.id),
    desired: average(
      feature.screen_ids.map((screenId) => screenCenters.get(screenId)).filter((value): value is number => value !== undefined),
      fallbackCenter(index, spec.features.length + (spec.auth.enabled ? 1 : 0)),
    ),
    height: nodeHeight('feature'),
    order: index,
  }));

  if (spec.auth.enabled) {
    const protectedCenters = (spec.auth.protected_screen_ids ?? [])
      .map((screenId) => screenCenters.get(screenId))
      .filter((value): value is number => value !== undefined);
    sourceItems.push({
      id: nodeIds.auth,
      desired: average(protectedCenters, totalHeight),
      height: nodeHeight('auth'),
      order: spec.features.length,
    });
  }
  packColumn(positions, COL.feature, sourceItems);

  const saveCenters = new Map<string, number[]>();
  for (const behavior of spec.behaviors ?? []) {
    const center = behaviorCenters.get(behavior.id);
    if (center === undefined) continue;
    for (const action of behavior.actions) {
      if (action.kind !== 'save') continue;
      const centers = saveCenters.get(action.entity) ?? [];
      centers.push(center);
      saveCenters.set(action.entity, centers);
    }
  }

  const entityItems: PackedItem[] = spec.database.entities.map((entity, index) => ({
    id: nodeIds.entity(entity.name),
    desired: average(saveCenters.get(entity.name) ?? [], fallbackCenter(index, spec.database.entities.length)),
    height: nodeHeight('entity', entity.fields.length),
    order: index,
  }));
  packEntityGrid(positions, entityItems);

  return positions;
}

export function specToGraph(spec: AppSpec, layout?: BlueprintLayout | null): BlueprintGraph {
  const nodes: BlueprintNode[] = [];
  const edges: BlueprintEdge[] = [];
  const autoLayout = calculateBlueprintAutoLayout(spec);
  const pos = (id: string): BlueprintPosition => layout?.positions[id] ?? autoLayout[id] ?? { x: 0, y: 0 };
  const protectedIds = new Set(spec.auth.protected_screen_ids ?? []);

  spec.features.forEach((feature) => {
    const id = nodeIds.feature(feature.id);
    nodes.push({
      id,
      type: 'feature',
      position: pos(id),
      data: { kind: 'feature', featureId: feature.id, label: feature.name, description: feature.description },
    });
    for (const screenId of feature.screen_ids) {
      edges.push({ id: `e:feature:${feature.id}:${screenId}`, source: id, target: nodeIds.screen(screenId), kind: 'feature-screen' });
    }
  });

  spec.screens.forEach((screen) => {
    const id = nodeIds.screen(screen.id);
    nodes.push({
      id,
      type: 'screen',
      position: pos(id),
      data: {
        kind: 'screen',
        screenId: screen.id,
        label: screen.label,
        purpose: screen.purpose,
        primary: screen.primary === true,
        protected: protectedIds.has(screen.id),
      },
    });
  });

  for (const behavior of spec.behaviors ?? []) {
    const id = nodeIds.behavior(behavior.id);
    nodes.push({
      id,
      type: 'behavior',
      position: pos(id),
      data: {
        kind: 'behavior',
        behaviorId: behavior.id,
        screenId: behavior.screen_id,
        trigger: behavior.trigger,
        label: behavior.trigger_label,
        actions: behavior.actions,
      },
    });
    edges.push({
      id: `e:screen:${behavior.screen_id}:behavior:${behavior.id}`,
      source: nodeIds.screen(behavior.screen_id),
      target: id,
      kind: 'screen-behavior',
      label: behavior.trigger,
    });
    behavior.actions.forEach((action, index) => {
      if (action.kind === 'save') {
        edges.push({
          id: `e:behavior:${behavior.id}:save:${index}`,
          source: id,
          target: nodeIds.entity(action.entity),
          kind: 'behavior-target',
          label: 'save',
        });
      } else if (action.kind === 'navigate') {
        edges.push({
          id: `e:behavior:${behavior.id}:nav:${index}`,
          source: id,
          target: nodeIds.screen(action.screen_id),
          kind: 'behavior-target',
          label: 'navigate',
        });
      }
    });
  }

  spec.database.entities.forEach((entity) => {
    const id = nodeIds.entity(entity.name);
    nodes.push({
      id,
      type: 'entity',
      position: pos(id),
      data: {
        kind: 'entity',
        entityName: entity.name,
        label: entity.label,
        fields: entity.fields.map((field) => ({
          name: field.name,
          label: field.label,
          type: field.type,
          ...(field.required ? { required: true } : {}),
          ...(field.references ? { references: field.references } : {}),
        })),
      },
    });
    for (const field of entity.fields) {
      if (field.references) {
        edges.push({
          id: `e:entity:${entity.name}:${field.name}`,
          source: id,
          target: nodeIds.entity(field.references),
          kind: 'entity-ref',
          label: field.name,
        });
      }
    }
  });

  if (spec.auth.enabled) {
    nodes.push({
      id: nodeIds.auth,
      type: 'auth',
      position: pos(nodeIds.auth),
      data: { kind: 'auth', enabled: true, methods: spec.auth.methods ?? [] },
    });
    for (const screenId of protectedIds) {
      edges.push({ id: `e:auth:${screenId}`, source: nodeIds.auth, target: nodeIds.screen(screenId), kind: 'auth-screen' });
    }
  }

  // O canvas nunca renderiza uma aresta pendurada durante uma edicao parcial.
  const known = new Set(nodes.map((node) => node.id));
  return { nodes, edges: edges.filter((edge) => known.has(edge.source) && known.has(edge.target)) };
}
