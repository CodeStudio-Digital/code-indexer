/**
 * Migration 220 — convert persisted pre-v5 spec impacts to the four workflow
 * phases. The active runtime only reads the canonical `affected_phases` shape.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;
type Phase = 'define' | 'blueprint' | 'build' | 'deliver';

const STAGE_PHASE: Record<string, Phase> = {
  discovery: 'define',
  product: 'define',
  architecture: 'blueprint',
  database: 'blueprint',
  ux: 'blueprint',
  wireframe: 'blueprint',
  design: 'build',
  backend: 'build',
  review: 'deliver',
  launch: 'deliver',
};
const PHASE_ORDER: Phase[] = ['define', 'blueprint', 'build', 'deliver'];

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))];
}

function upgradeImpact(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const canonical = new Set(strings(parsed.affected_phases).filter((phase): phase is Phase => PHASE_ORDER.includes(phase as Phase)));
    for (const stage of strings(parsed.stage_ids)) {
      const phase = STAGE_PHASE[stage];
      if (phase) canonical.add(phase);
    }
    const level = parsed.level;
    if (level !== 'none' && level !== 'low' && level !== 'medium' && level !== 'high') return null;
    return JSON.stringify({
      level,
      affected_phases: PHASE_ORDER.filter((phase) => canonical.has(phase)),
      source_ids: strings(parsed.source_ids),
      reasons: strings(parsed.reasons),
    });
  } catch {
    return null;
  }
}

function upgradeTable(db: DB, table: string): void {
  if (!tableExists(db, table)) return;
  const rows = db.prepare(`SELECT id, impact_json FROM ${table} WHERE impact_json IS NOT NULL`)
    .all() as Array<{ id: number; impact_json: string }>;
  const update = db.prepare(`UPDATE ${table} SET impact_json = ? WHERE id = ?`);
  for (const row of rows) {
    const upgraded = upgradeImpact(row.impact_json);
    if (upgraded) update.run(upgraded, row.id);
  }
}

export const appStudioImpactV5220: Migration = {
  version: 220,
  name: 'app_studio_impact_v5',
  up(db: DB): void {
    upgradeTable(db, 'app_studio_spec_revisions');
    upgradeTable(db, 'app_studio_evolutions');
  },
};
