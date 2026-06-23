/** Per-tier backup retention policy + the pure "which to prune" selection.
 *  `-1` means unlimited. Free/unknown get no retention (the route gates creation
 *  on the `backup` feature first, so this is just a safe floor). */
import type { BackupRef } from './types.js';

export interface RetentionPolicy {
  /** Max backups kept; -1 = unlimited. */
  maxCount: number;
  /** Time-to-live in ms; -1 = never expire. */
  ttlMs: number;
}

const DAY_MS = 86_400_000;

const POLICIES: Record<string, RetentionPolicy> = {
  pro: { maxCount: 30, ttlMs: 30 * DAY_MS },
  team: { maxCount: 100, ttlMs: 90 * DAY_MS },
  enterprise: { maxCount: -1, ttlMs: -1 },
};

export function retentionFor(tier: string): RetentionPolicy {
  return POLICIES[tier] ?? { maxCount: 0, ttlMs: 0 };
}

/** Expiry stamp for a new backup, or null when the tier never expires. */
export function expiryFor(policy: RetentionPolicy, nowMs: number): number | null {
  return policy.ttlMs > 0 ? nowMs + policy.ttlMs : null;
}

/**
 * Given all current backups + the policy + now, the ids to prune: anything past
 * its expiry, plus the oldest beyond `maxCount`. Pure — the service deletes them.
 */
export function selectPrunable(existing: BackupRef[], policy: RetentionPolicy, nowMs: number): string[] {
  const newestFirst = [...existing].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const prune = new Set<string>();
  for (const b of newestFirst) {
    if (b.expiresAtMs != null && b.expiresAtMs <= nowMs) prune.add(b.id);
  }
  if (policy.maxCount >= 0) {
    const survivors = newestFirst.filter((b) => !prune.has(b.id));
    for (const b of survivors.slice(policy.maxCount)) prune.add(b.id);
  }
  return [...prune];
}
