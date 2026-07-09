/**
 * Roadmap de features do App Studio — derivado da AppSpec aprovada (nunca
 * de um catálogo fixo: cada app tem o seu). 1 item tier 'screen' por tela
 * da spec; 1 item tier 'api' por entity (CRUD) e por feature sem tela. O
 * PROGRESSO nunca é armazenado — deriva em leitura por name-match contra
 * as features registradas via `app_record_feature` (tabela
 * app_studio_features, kind espelha o tier).
 */
import type { AppSpec } from '../spec/types.js';

export type AppRoadmapTier = 'screen' | 'api';

/** Kind das linhas registradas (app_studio_features.kind). */
export type AppRecordedKind = 'screen' | 'api' | 'feature';

export interface AppRoadmapItem {
  /** Nome de código do deliverable (screen.name ou entity/feature name). */
  name: string;
  tier: AppRoadmapTier;
  /** Feature da spec que originou o item (null p/ CRUD de entity). */
  feature_id: string | null;
  source: 'spec';
}

const normalize = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * (Re)constrói o roadmap a partir da spec. Chamado por `app_save_spec` a
 * cada save (permitido só enquanto discovery não está aprovado) via
 * `replaceRoadmap` — o roadmap nasce VAZIO no scaffold porque a spec ainda
 * não existe.
 */
export function buildFeatureRoadmap(spec: AppSpec): AppRoadmapItem[] {
  const items: AppRoadmapItem[] = [];

  for (const screen of spec.screens) {
    const owner = spec.features.find((f) => f.screen_ids.includes(screen.id));
    items.push({ name: screen.name, tier: 'screen', feature_id: owner?.id ?? null, source: 'spec' });
  }

  if (spec.database.required) {
    for (const entity of spec.database.entities) {
      items.push({ name: entity.name, tier: 'api', feature_id: null, source: 'spec' });
    }
  }

  // Features sem tela (jobs, integrações) viram deliverables de API — desde
  // que não colidam com o CRUD de uma entity homônima.
  for (const feature of spec.features) {
    if (feature.screen_ids.length > 0) continue;
    if (items.some((item) => item.tier === 'api' && normalize(item.name) === normalize(feature.name))) continue;
    items.push({ name: feature.name, tier: 'api', feature_id: feature.id, source: 'spec' });
  }

  return items;
}

/**
 * Progresso derivado, tier-aware: item 'screen' só é coberto por registro
 * kind 'screen'; item 'api' por kind 'api' (kind 'feature' é informativo,
 * não cobre roadmap).
 */
export function roadmapProgress(
  roadmap: AppRoadmapItem[],
  recorded: Array<{ name: string; kind: AppRecordedKind }>,
): Array<AppRoadmapItem & { recorded: boolean }> {
  const byTier: Record<AppRoadmapTier, Set<string>> = { screen: new Set(), api: new Set() };
  for (const r of recorded) {
    if (r.kind === 'screen' || r.kind === 'api') byTier[r.kind].add(normalize(r.name));
  }
  return roadmap.map((item) => ({ ...item, recorded: byTier[item.tier].has(normalize(item.name)) }));
}
