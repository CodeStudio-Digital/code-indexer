/**
 * Diff estruturado entre duas specs — alimenta a revisão versionada e a
 * mensagem de reconciliação quando o usuário "Aplica mudanças" do
 * Blueprint com a spec travada. Estruturado (não texto) para a UI
 * renderizar com i18n; `formatDiffSummary` é o fallback compacto.
 */
import type { AppSpec } from '../spec/types.js';

export type DiffKind = 'screen' | 'entity' | 'feature' | 'behavior' | 'auth';
export interface DiffEntry {
  type: 'added' | 'removed' | 'changed';
  kind: DiffKind;
  /** Label humano do item (da spec nova quando existe; senão da antiga). */
  label: string;
}

function collect<T>(
  entries: DiffEntry[],
  kind: DiffKind,
  before: T[],
  after: T[],
  keyOf: (item: T) => string,
  labelOf: (item: T) => string,
): void {
  const beforeMap = new Map(before.map((item) => [keyOf(item), item]));
  const afterMap = new Map(after.map((item) => [keyOf(item), item]));
  for (const [key, item] of afterMap) {
    const old = beforeMap.get(key);
    if (!old) entries.push({ type: 'added', kind, label: labelOf(item) });
    else if (JSON.stringify(old) !== JSON.stringify(item)) entries.push({ type: 'changed', kind, label: labelOf(item) });
  }
  for (const [key, item] of beforeMap) {
    if (!afterMap.has(key)) entries.push({ type: 'removed', kind, label: labelOf(item) });
  }
}

export function diffSpec(before: AppSpec, after: AppSpec): DiffEntry[] {
  const entries: DiffEntry[] = [];
  collect(entries, 'screen', before.screens, after.screens, (s) => s.id, (s) => s.label);
  collect(entries, 'entity', before.database.entities, after.database.entities, (e) => e.name, (e) => e.label);
  collect(entries, 'feature', before.features, after.features, (f) => f.id, (f) => f.name);
  collect(entries, 'behavior', before.behaviors ?? [], after.behaviors ?? [], (b) => b.id, (b) => b.trigger_label);
  if (JSON.stringify(before.auth) !== JSON.stringify(after.auth)) {
    entries.push({ type: 'changed', kind: 'auth', label: 'login' });
  }
  return entries;
}

const MARK: Record<DiffEntry['type'], string> = { added: '+', removed: '-', changed: '~' };

/** Fallback compacto: "+ screen 'Painel'; - entity 'Clientes'; ~ auth". */
export function formatDiffSummary(entries: DiffEntry[], kindLabels?: Partial<Record<DiffKind, string>>): string {
  if (entries.length === 0) return '';
  return entries
    .map((e) => `${MARK[e.type]} ${kindLabels?.[e.kind] ?? e.kind} '${e.label}'`)
    .join('; ');
}
