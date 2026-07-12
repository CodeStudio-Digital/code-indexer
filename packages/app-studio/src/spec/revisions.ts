import type { AppStageId } from '../pipeline/stages.js';
import type { AppSpec } from './types.js';

export type AppSpecDiffKind =
  | 'summary'
  | 'audience'
  | 'requirements'
  | 'screens'
  | 'features'
  | 'database'
  | 'auth'
  | 'design'
  | 'behaviors';

export interface AppSpecCollectionDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface AppSpecDiff {
  summaryChanged: boolean;
  audienceChanged: boolean;
  requirementsChanged: boolean;
  authChanged: boolean;
  designChanged: boolean;
  screens: AppSpecCollectionDiff;
  features: AppSpecCollectionDiff;
  entities: AppSpecCollectionDiff;
  behaviors: AppSpecCollectionDiff;
}

export interface AppSpecImpact {
  level: 'none' | 'low' | 'medium' | 'high';
  stage_ids: AppStageId[];
  reasons: string[];
}

export function createEmptySpecDiff(): AppSpecDiff {
  return {
    summaryChanged: false,
    audienceChanged: false,
    requirementsChanged: false,
    authChanged: false,
    designChanged: false,
    screens: emptyCollectionDiff(),
    features: emptyCollectionDiff(),
    entities: emptyCollectionDiff(),
    behaviors: emptyCollectionDiff(),
  };
}

export function specDiffHasChanges(diff: AppSpecDiff): boolean {
  return (
    diff.summaryChanged ||
    diff.audienceChanged ||
    diff.requirementsChanged ||
    diff.authChanged ||
    diff.designChanged ||
    collectionHasChanges(diff.screens) ||
    collectionHasChanges(diff.features) ||
    collectionHasChanges(diff.entities) ||
    collectionHasChanges(diff.behaviors)
  );
}

export function diffAppSpecs(base: AppSpec | null, next: AppSpec): AppSpecDiff {
  const diff = createEmptySpecDiff();
  if (!base) {
    diff.summaryChanged = !!next.summary;
    diff.audienceChanged = !!next.audience;
    diff.requirementsChanged = !!next.requirements;
    diff.authChanged = !!next.auth.enabled;
    diff.designChanged = !!next.design.tone || !!next.design.primary_color;
    diff.screens.added = next.screens.map((s) => s.label || s.id);
    diff.features.added = next.features.map((f) => f.name || f.id);
    diff.entities.added = next.database.entities.map((e) => e.label || e.name);
    diff.behaviors.added = (next.behaviors ?? []).map((b) => b.trigger_label || b.id);
    return diff;
  }

  diff.summaryChanged = base.summary !== next.summary;
  diff.audienceChanged = base.audience !== next.audience;
  diff.requirementsChanged = stableStringify(base.requirements ?? null) !== stableStringify(next.requirements ?? null);
  diff.authChanged = stableStringify(base.auth) !== stableStringify(next.auth);
  diff.designChanged = stableStringify(base.design) !== stableStringify(next.design);
  diff.screens = compareByKey(base.screens, next.screens, (s) => s.id, (s) => s.label || s.id);
  diff.features = compareByKey(base.features, next.features, (f) => f.id, (f) => f.name || f.id);
  diff.entities = compareByKey(base.database.entities, next.database.entities, (e) => e.name, (e) => e.label || e.name);
  diff.behaviors = compareByKey(base.behaviors ?? [], next.behaviors ?? [], (b) => b.id, (b) => b.trigger_label || b.id);
  return diff;
}

export function impactFromSpecDiff(diff: AppSpecDiff): AppSpecImpact {
  const stages = new Set<AppStageId>();
  const reasons: string[] = [];

  if (specDiffHasChanges(diff)) {
    stages.add('product');
    reasons.push('O plano mudou; profundidade, horizontes e cenarios do produto precisam ser confirmados novamente antes da arquitetura.');
  }

  if (collectionHasChanges(diff.entities)) {
    addStages(stages, ['database', 'ux', 'wireframe', 'design', 'backend', 'review']);
    reasons.push('Dados/tabelas mudaram; a estrutura do banco e as regras por tras das telas precisam ser revisitadas.');
  }
  if (collectionHasChanges(diff.screens) || collectionHasChanges(diff.features) || diff.designChanged) {
    addStages(stages, ['ux', 'wireframe', 'design', 'backend', 'review']);
    reasons.push('Telas, recursos ou direcao visual mudaram; a interface e a ligacao com dados podem precisar de ajuste.');
  }
  if (collectionHasChanges(diff.behaviors)) {
    addStages(stages, ['wireframe', 'design', 'backend', 'review']);
    reasons.push('Acoes do app mudaram; botoes, formularios ou avisos precisam ser conferidos.');
  }
  if (diff.authChanged) {
    addStages(stages, ['ux', 'wireframe', 'design', 'backend', 'review']);
    reasons.push('Login ou telas protegidas mudaram; regras de acesso precisam ser conferidas.');
  }
  if (diff.summaryChanged || diff.audienceChanged || diff.requirementsChanged) {
    addStages(stages, ['ux', 'wireframe', 'design', 'review']);
    reasons.push('Objetivo, publico ou criterios de aceite mudaram; a revisao final precisa considerar o novo combinado.');
  }

  const stage_ids = [...stages].sort((a, b) => STAGE_ORDER[a] - STAGE_ORDER[b]);
  return {
    level: impactLevel(stage_ids, diff),
    stage_ids,
    reasons,
  };
}

export function summarizeSpecDiff(diff: AppSpecDiff): string[] {
  const lines: string[] = [];
  if (diff.summaryChanged) lines.push('Resumo da ideia atualizado.');
  if (diff.audienceChanged) lines.push('Publico-alvo atualizado.');
  if (diff.requirementsChanged) lines.push('Requisitos, regras ou criterios de aceite atualizados.');
  pushCollectionSummary(lines, 'Telas', diff.screens);
  pushCollectionSummary(lines, 'Recursos', diff.features);
  pushCollectionSummary(lines, 'Dados/tabelas', diff.entities);
  if (diff.authChanged) lines.push('Configuracao de login alterada.');
  if (diff.designChanged) lines.push('Direcao visual alterada.');
  pushCollectionSummary(lines, 'Acoes do app', diff.behaviors);
  return lines.length ? lines : ['Nenhuma mudanca estrutural detectada.'];
}

const STAGE_ORDER: Record<AppStageId, number> = {
  discovery: 0,
  product: 1,
  architecture: 2,
  database: 3,
  ux: 4,
  wireframe: 5,
  design: 6,
  backend: 7,
  review: 8,
  launch: 9,
};

function emptyCollectionDiff(): AppSpecCollectionDiff {
  return { added: [], removed: [], changed: [] };
}

function collectionHasChanges(diff: AppSpecCollectionDiff): boolean {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
}

function addStages(target: Set<AppStageId>, stages: AppStageId[]): void {
  for (const stage of stages) target.add(stage);
}

function impactLevel(stageIds: AppStageId[], diff: AppSpecDiff): AppSpecImpact['level'] {
  if (stageIds.length === 0) return 'none';
  if (collectionHasChanges(diff.entities) || diff.authChanged || hasRemovals(diff)) return 'high';
  if (stageIds.includes('backend') || stageIds.includes('design')) return 'medium';
  return 'low';
}

function hasRemovals(diff: AppSpecDiff): boolean {
  return (
    diff.screens.removed.length > 0 ||
    diff.features.removed.length > 0 ||
    diff.entities.removed.length > 0 ||
    diff.behaviors.removed.length > 0
  );
}

function pushCollectionSummary(lines: string[], label: string, diff: AppSpecCollectionDiff): void {
  if (!collectionHasChanges(diff)) return;
  const parts: string[] = [];
  if (diff.added.length) parts.push(`+${diff.added.length}`);
  if (diff.removed.length) parts.push(`-${diff.removed.length}`);
  if (diff.changed.length) parts.push(`${diff.changed.length} ajustado(s)`);
  lines.push(`${label}: ${parts.join(', ')}.`);
}

function compareByKey<T>(
  before: T[],
  after: T[],
  keyOf: (value: T) => string,
  labelOf: (value: T) => string,
): AppSpecCollectionDiff {
  const beforeMap = new Map(before.map((value) => [keyOf(value), value]));
  const afterMap = new Map(after.map((value) => [keyOf(value), value]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [key, value] of afterMap) {
    const old = beforeMap.get(key);
    if (!old) added.push(labelOf(value));
    else if (stableStringify(old) !== stableStringify(value)) changed.push(labelOf(value));
  }
  for (const [key, value] of beforeMap) {
    if (!afterMap.has(key)) removed.push(labelOf(value));
  }
  return { added, removed, changed };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForCompare(value));
}

function sortForCompare(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForCompare);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortForCompare((value as Record<string, unknown>)[key]);
  }
  return out;
}
