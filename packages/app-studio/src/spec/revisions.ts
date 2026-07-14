import type { AppWorkflowPhaseId } from '../workflow/types.js';
import type { AppSpec } from './types.js';
import { stableRequirementSourceIds, upgradeAppSpecToV2, type AppRequirementKind } from './stable-ids.js';

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
  /** Exact stable source ids changed by this revision. */
  changed_source_ids: string[];
}

export interface AppSpecImpact {
  level: 'none' | 'low' | 'medium' | 'high';
  affected_phases: AppWorkflowPhaseId[];
  /** Exact ids or prefix selectors ending in `*`; used for selective invalidation. */
  source_ids: string[];
  reasons: string[];
}

/** Parse the canonical v5 impact payload without trusting persisted JSON. */
export function parseAppSpecImpact(raw: unknown): AppSpecImpact | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const level = record.level;
  if (level !== 'none' && level !== 'low' && level !== 'medium' && level !== 'high') return null;

  const affected_phases = uniqueStrings(record.affected_phases)
    .filter((phase): phase is AppWorkflowPhaseId => phase in PHASE_ORDER)
    .sort((left, right) => PHASE_ORDER[left] - PHASE_ORDER[right]);
  return {
    level,
    affected_phases,
    source_ids: uniqueStrings(record.source_ids),
    reasons: uniqueStrings(record.reasons),
  };
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
    changed_source_ids: [],
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
    diff.changed_source_ids = allSpecSourceIds(next);
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
  const changedSources = new Set<string>();
  if (diff.summaryChanged) changedSources.add('spec:summary');
  if (diff.audienceChanged) changedSources.add('spec:audience');
  if (diff.authChanged) changedSources.add('auth');
  if (diff.designChanged) changedSources.add('design');
  addChangedKeys(changedSources, base.screens, next.screens, (item) => item.id, 'screen');
  addChangedKeys(changedSources, base.features, next.features, (item) => item.id, 'feature');
  addChangedKeys(changedSources, base.database.entities, next.database.entities, (item) => item.name, 'entity');
  addChangedKeys(changedSources, base.behaviors ?? [], next.behaviors ?? [], (item) => item.id, 'behavior');
  addChangedRequirementSources(changedSources, upgradeAppSpecToV2(base), upgradeAppSpecToV2(next));
  diff.changed_source_ids = [...changedSources].sort();
  return diff;
}

export function impactFromSpecDiff(diff: AppSpecDiff): AppSpecImpact {
  const phases = new Set<AppWorkflowPhaseId>();
  const sourceIds = new Set<string>();
  const reasons: string[] = [];

  if (specDiffHasChanges(diff)) {
    phases.add('define');
    reasons.push('O escopo mudou; o novo pacote precisa ser rastreado antes de atualizar os trabalhos dependentes.');
  }
  for (const sourceId of diff.changed_source_ids) sourceIds.add(sourceId);

  if (collectionHasChanges(diff.entities)) {
    addPhases(phases, ['blueprint', 'build', 'deliver']);
    reasons.push('Dados/tabelas mudaram; a estrutura do banco e as regras por tras das telas precisam ser revisitadas.');
  }
  if (collectionHasChanges(diff.screens) || collectionHasChanges(diff.features) || diff.designChanged) {
    addPhases(phases, ['blueprint', 'build', 'deliver']);
    reasons.push('Telas, recursos ou direcao visual mudaram; a interface e a ligacao com dados podem precisar de ajuste.');
  }
  if (collectionHasChanges(diff.behaviors)) {
    addPhases(phases, ['blueprint', 'build', 'deliver']);
    reasons.push('Acoes do app mudaram; botoes, formularios ou avisos precisam ser conferidos.');
  }
  if (diff.authChanged) {
    addPhases(phases, ['blueprint', 'build', 'deliver']);
    reasons.push('Login ou telas protegidas mudaram; regras de acesso precisam ser conferidas.');
  }
  if (diff.summaryChanged || diff.audienceChanged || diff.requirementsChanged) {
    addPhases(phases, ['blueprint', 'build', 'deliver']);
    reasons.push('Objetivo, publico ou criterios de aceite mudaram; a revisao final precisa considerar o novo combinado.');
  }

  const affected_phases = [...phases].sort((a, b) => PHASE_ORDER[a] - PHASE_ORDER[b]);
  return {
    level: impactLevel(affected_phases, diff),
    affected_phases,
    source_ids: [...sourceIds].sort(),
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

const PHASE_ORDER: Record<AppWorkflowPhaseId, number> = { define: 0, blueprint: 1, build: 2, deliver: 3 };

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))];
}

function emptyCollectionDiff(): AppSpecCollectionDiff {
  return { added: [], removed: [], changed: [] };
}

function collectionHasChanges(diff: AppSpecCollectionDiff): boolean {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
}

function addPhases(target: Set<AppWorkflowPhaseId>, phases: AppWorkflowPhaseId[]): void {
  for (const phase of phases) target.add(phase);
}

function impactLevel(phases: AppWorkflowPhaseId[], diff: AppSpecDiff): AppSpecImpact['level'] {
  if (phases.length === 0) return 'none';
  if (collectionHasChanges(diff.entities) || diff.authChanged || hasRemovals(diff)) return 'high';
  if (phases.includes('build')) return 'medium';
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

function addChangedKeys<T>(
  target: Set<string>,
  before: T[],
  after: T[],
  keyOf: (value: T) => string,
  prefix: string,
): void {
  const beforeMap = new Map(before.map((value) => [keyOf(value), value]));
  const afterMap = new Map(after.map((value) => [keyOf(value), value]));
  for (const key of new Set([...beforeMap.keys(), ...afterMap.keys()])) {
    if (stableStringify(beforeMap.get(key)) !== stableStringify(afterMap.get(key))) target.add(`${prefix}:${key}`);
  }
}

const REQUIREMENT_KINDS: AppRequirementKind[] = ['goal', 'rule', 'acceptance', 'out-of-scope', 'assumption', 'risk'];

function requirementValues(spec: AppSpec, kind: AppRequirementKind): string[] {
  return kind === 'goal' ? spec.requirements?.goals ?? []
    : kind === 'rule' ? spec.requirements?.business_rules ?? []
      : kind === 'acceptance' ? spec.requirements?.acceptance_criteria ?? []
        : kind === 'out-of-scope' ? spec.requirements?.out_of_scope ?? []
          : kind === 'assumption' ? spec.requirements?.assumptions ?? []
            : spec.requirements?.risks ?? [];
}

function addChangedRequirementSources(target: Set<string>, before: AppSpec, after: AppSpec): void {
  for (const kind of REQUIREMENT_KINDS) {
    const beforeIds = stableRequirementSourceIds(before, kind);
    const afterIds = stableRequirementSourceIds(after, kind);
    const beforeMap = new Map(beforeIds.map((id, index) => [id, requirementValues(before, kind)[index] ?? '']));
    const afterMap = new Map(afterIds.map((id, index) => [id, requirementValues(after, kind)[index] ?? '']));
    for (const id of new Set([...beforeMap.keys(), ...afterMap.keys()])) {
      if (beforeMap.get(id) !== afterMap.get(id)) target.add(id);
    }
  }
}

function allSpecSourceIds(spec: AppSpec): string[] {
  const ids = new Set<string>([
    'spec:summary', 'spec:audience', 'auth', 'design',
    ...spec.screens.map((item) => `screen:${item.id}`),
    ...spec.features.map((item) => `feature:${item.id}`),
    ...spec.database.entities.map((item) => `entity:${item.name}`),
    ...(spec.behaviors ?? []).map((item) => `behavior:${item.id}`),
  ]);
  for (const kind of REQUIREMENT_KINDS) for (const id of stableRequirementSourceIds(spec, kind)) ids.add(id);
  return [...ids].sort();
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
