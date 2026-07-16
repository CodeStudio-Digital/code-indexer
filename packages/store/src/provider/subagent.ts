import type { Database as DB } from 'better-sqlite3';
import * as providers from './providers.js';

/** One per-profile override inside `extra.subagent_profiles`. All keys optional. */
interface ProfileEntry {
  provider_id?: string;
  model?: string;
  /** Reasoning-effort override (e.g. minimal/low/medium/high/xhigh) for this profile. */
  effort?: string;
}

function readStr(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readProfiles(extra: Record<string, unknown> | undefined): Record<string, ProfileEntry> {
  const raw = extra?.subagent_profiles;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, ProfileEntry>;
}

function persistExtra(db: DB, providerId: string, extra: Record<string, unknown>): void {
  db
    .prepare('UPDATE provider_configs SET extra = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(extra), new Date().toISOString(), providerId);
}

/**
 * Merge a patch into `extra.subagent_profiles[profileId]`, preserving the keys
 * not named in the patch (so setting the model never clobbers the effort, and
 * vice-versa). A key set to `undefined`/'' is cleared; an entry with no keys
 * left is removed, and an empty map is stripped entirely.
 */
function updateProfileEntry(
  db: DB,
  providerId: string,
  profileId: string,
  patch: Partial<Record<keyof ProfileEntry, string | null>>,
): void {
  const cfg = providers.get(db, providerId);
  if (!cfg) return;
  const nextExtra = { ...cfg.extra };
  const profiles: Record<string, ProfileEntry> = { ...readProfiles(cfg.extra) };
  const entry: ProfileEntry = { ...profiles[profileId] };
  for (const key of Object.keys(patch) as (keyof ProfileEntry)[]) {
    const v = patch[key];
    if (v === null || v === undefined || v === '') delete entry[key];
    else entry[key] = v;
  }
  if (!entry.provider_id && !entry.model && !entry.effort) delete profiles[profileId];
  else profiles[profileId] = entry;
  if (Object.keys(profiles).length === 0) delete nextExtra.subagent_profiles;
  else nextExtra.subagent_profiles = profiles;
  persistExtra(db, providerId, nextExtra);
}

export function getTarget(db: DB, providerId: string): { providerId: string; modelId: string | null } | null {
  const cfg = providers.get(db, providerId);
  if (!cfg) return null;
  const targetProvider = cfg.extra?.subagent_provider_id;
  const provider = typeof targetProvider === 'string' && targetProvider.length > 0
    ? targetProvider
    : providerId;
  const model = getModel(db, providerId);
  if (provider === providerId && !model) return null;
  return { providerId: provider, modelId: model };
}

export function getModel(db: DB, providerId: string): string | null {
  const cfg = providers.get(db, providerId);
  if (!cfg) return null;
  const value = cfg.extra?.subagent_model;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function setModel(db: DB, providerId: string, modelId: string | null): void {
  const current = getTarget(db, providerId);
  setTarget(db, providerId, current?.providerId ?? providerId, modelId);
}

export function setTarget(
  db: DB,
  providerId: string,
  targetProviderId: string | null,
  modelId: string | null,
): void {
  const cfg = providers.get(db, providerId);
  if (!cfg) return;
  const nextExtra = { ...cfg.extra };
  if (!targetProviderId || targetProviderId === providerId) delete nextExtra.subagent_provider_id;
  else nextExtra.subagent_provider_id = targetProviderId;
  if (modelId === null || modelId === '') delete nextExtra.subagent_model;
  else nextExtra.subagent_model = modelId;
  db
    .prepare('UPDATE provider_configs SET extra = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(nextExtra), new Date().toISOString(), providerId);
}

/**
 * Resolve the subagent provider/model for a specific micro-agent profile,
 * applying the precedence: per-profile override → default subagent target →
 * inherit the parent (returns `null` when it resolves to the parent provider
 * with no model, mirroring `getTarget`).
 *
 * If the profile pins a `provider_id`, the model comes from the override only
 * (never the default model, which belongs to a different provider). If it only
 * overrides the model, the provider is the default's (or the parent).
 */
export function getProfileTarget(
  db: DB,
  providerId: string,
  profileId: string,
): { providerId: string; modelId: string | null } | null {
  const cfg = providers.get(db, providerId);
  if (!cfg) return null;
  const entry = readProfiles(cfg.extra)[profileId];
  const overrideProvider = readStr(entry?.provider_id);
  const overrideModel = readStr(entry?.model);
  const defaultProvider = readStr(cfg.extra?.subagent_provider_id);
  const defaultModel = readStr(cfg.extra?.subagent_model);

  let provider: string;
  let model: string | null;
  if (overrideProvider) {
    provider = overrideProvider;
    model = overrideModel;
  } else if (overrideModel) {
    provider = defaultProvider ?? providerId;
    model = overrideModel;
  } else {
    provider = defaultProvider ?? providerId;
    model = defaultModel;
  }
  if (provider === providerId && !model) return null;
  return { providerId: provider, modelId: model };
}

/**
 * Write a per-profile subagent override into `extra.subagent_profiles`.
 * Passing both `null` (the "use default" UI option) removes the entry; an
 * empty `subagent_profiles` map is stripped entirely. An explicit
 * `targetProviderId` is stored as-is (even when it equals the parent) so a
 * profile can pin the parent provider while the default points elsewhere.
 */
export function setProfileTarget(
  db: DB,
  providerId: string,
  profileId: string,
  targetProviderId: string | null,
  modelId: string | null,
): void {
  updateProfileEntry(db, providerId, profileId, { provider_id: targetProviderId, model: modelId });
}

// ─── Reasoning effort (orthogonal to provider/model) ─────────────

/** Default subagent reasoning-effort override (`extra.subagent_effort`). */
export function getSubagentEffort(db: DB, providerId: string): string | null {
  const cfg = providers.get(db, providerId);
  if (!cfg) return null;
  return readStr(cfg.extra?.subagent_effort);
}

export function setSubagentEffort(db: DB, providerId: string, effort: string | null): void {
  const cfg = providers.get(db, providerId);
  if (!cfg) return;
  const nextExtra = { ...cfg.extra };
  if (effort === null || effort === '') delete nextExtra.subagent_effort;
  else nextExtra.subagent_effort = effort;
  persistExtra(db, providerId, nextExtra);
}

/**
 * Reasoning effort for a profile: per-profile override → default subagent
 * effort → null (inherit the parent session's effort at runtime).
 */
export function getProfileEffort(db: DB, providerId: string, profileId: string): string | null {
  const cfg = providers.get(db, providerId);
  if (!cfg) return null;
  const entry = readProfiles(cfg.extra)[profileId];
  return readStr(entry?.effort) ?? readStr(cfg.extra?.subagent_effort);
}

export function setProfileEffort(
  db: DB,
  providerId: string,
  profileId: string,
  effort: string | null,
): void {
  updateProfileEntry(db, providerId, profileId, { effort });
}
