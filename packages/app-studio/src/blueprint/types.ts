/**
 * Tipos do modo Blueprint — o grafo é uma VIEW derivada da AppSpec
 * (specToGraph) e as edições são MUTAÇÕES nomeadas e cirúrgicas na spec
 * (applySpecMutation) — nunca reconstruímos a spec a partir do grafo.
 *
 * Tipos estruturais próprios (id/position/data), SEM importar @xyflow:
 * este pacote é puro/browser-safe; o dashboard casta para os tipos do
 * React Flow (mesmo espírito do ExecutionMapGraph do chat).
 */
import type { AppBehaviorAction, AppBehaviorTrigger, AppFieldType } from '../spec/types.js';

export type BlueprintNodeKind = 'screen' | 'entity' | 'feature' | 'auth' | 'behavior';

export interface BlueprintPosition {
  x: number;
  y: number;
}

/** Payload de cada nó — o que os componentes de nó renderizam. */
export type BlueprintNodeData =
  | { kind: 'screen'; screenId: string; label: string; purpose: string; primary: boolean; protected: boolean }
  | { kind: 'entity'; entityName: string; label: string; fields: Array<{ name: string; label: string; type: AppFieldType; required?: boolean; references?: string }> }
  | { kind: 'feature'; featureId: string; label: string; description: string }
  | { kind: 'auth'; enabled: boolean; methods: string[] }
  | { kind: 'behavior'; behaviorId: string; screenId: string; trigger: AppBehaviorTrigger; label: string; actions: AppBehaviorAction[] };

export interface BlueprintNode {
  /** Id estável: screen:<id> | entity:<name> | feature:<id> | auth | behavior:<id>. */
  id: string;
  type: BlueprintNodeKind;
  position: BlueprintPosition;
  data: BlueprintNodeData;
}

export type BlueprintEdgeKind =
  | 'feature-screen' // feature → tela onde aparece
  | 'entity-ref' // entity → entity (FK via fields[].references)
  | 'auth-screen' // login → tela protegida
  | 'screen-behavior' // tela do gatilho → behavior
  | 'behavior-target'; // behavior → entity(save) | screen(navigate)

export interface BlueprintEdge {
  id: string;
  source: string;
  target: string;
  kind: BlueprintEdgeKind;
  /** Rótulo curto (ex.: nome do campo FK, kind da action). */
  label?: string;
}

export interface BlueprintGraph {
  nodes: BlueprintNode[];
  edges: BlueprintEdge[];
}

/** Layout persistido (posições) — separado da spec (contrato semântico). */
export interface BlueprintLayout {
  v: 1;
  positions: Record<string, BlueprintPosition>;
}

export function parseBlueprintLayout(json: string | null | undefined): BlueprintLayout | null {
  if (!json) return null;
  try {
    const layout = JSON.parse(json) as BlueprintLayout;
    if (layout?.v !== 1 || typeof layout.positions !== 'object' || layout.positions === null) return null;
    return layout;
  } catch {
    return null;
  }
}

/** Ids de nó estáveis — única fonte (grafo, mutações e UI usam estes). */
export const nodeIds = {
  screen: (id: string): string => `screen:${id}`,
  entity: (name: string): string => `entity:${name}`,
  feature: (id: string): string => `feature:${id}`,
  auth: 'auth' as const,
  behavior: (id: string): string => `behavior:${id}`,
};
