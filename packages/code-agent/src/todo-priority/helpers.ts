/**
 * Heuristic signal extractors for todo priority.
 */
import type { TodoCandidate, TodoItem } from './types.js';

// Impact keywords — higher when the todo touches something critical.
// Note: "fix" alone is too generic ("fix typo" is low impact). We only flag
// high-impact when paired with a concrete severity word.
const HIGH_IMPACT_PATTERNS: RegExp[] = [
  /\b(bug|crash|broken|production|outage|hotfix|security)\b/i,
  /\b(blocker|critical|urgent|p0|p1)\b/i,
  /\b(rollback|revert)\b/i,
];

const MEDIUM_IMPACT_PATTERNS: RegExp[] = [
  /\b(refactor|migrate|deprecat\w+|cleanup)\b/i,
  /\b(test|coverage|lint|typecheck)\b/i,
  /\b(feature|implement|add)\b/i,
];

const LOW_IMPACT_PATTERNS: RegExp[] = [
  /\b(docs?|comment|rename|typo|formatting)\b/i,
];

export function detectImpact(content: string): number {
  for (const re of HIGH_IMPACT_PATTERNS)   if (re.test(content)) return 1.0;
  for (const re of MEDIUM_IMPACT_PATTERNS) if (re.test(content)) return 0.6;
  for (const re of LOW_IMPACT_PATTERNS)    if (re.test(content)) return 0.2;
  // Default — assume medium so we don't lower everything to the floor.
  return 0.4;
}

/** Quick-win signal: short descriptions score higher (1.0 at length 30, 0 at length 200+). */
export function detectQuickWin(content: string): number {
  const len = content.trim().length;
  if (len <= 30) return 1.0;
  if (len >= 200) return 0;
  return Math.max(0, 1 - (len - 30) / 170);
}

/**
 * Urgency by age — `in_progress` items get higher urgency as they linger.
 * Returns 0 for fresh items and saturates at 1.0 after 1 hour stalled.
 */
export function detectUrgency(item: TodoItem, nowMs: number): number {
  if (item.status !== 'in_progress') return 0;
  if (item.createdAtMs == null) return 0.3; // assume moderate if no timestamp
  const ageMinutes = Math.max(0, (nowMs - item.createdAtMs) / 60_000);
  return Math.min(1.0, ageMinutes / 60);
}

/**
 * Build adjacency map of refs → ids that reference them.
 * "Who blocks whom" — if A.refs includes B, then A is blocked BY B (and B
 * blocks A).
 */
export function buildAdjacency(items: TodoItem[]): {
  blockedByThis: Map<string, string[]>;
  blockedBy: Map<string, string[]>;
} {
  const blockedByThis = new Map<string, string[]>();
  const blockedBy = new Map<string, string[]>();
  const isPending = new Set(items.filter((i) => i.status === 'pending').map((i) => i.id));

  for (const item of items) {
    for (const refId of item.refs ?? []) {
      if (!isPending.has(refId)) continue; // ignore completed/in_progress refs
      // item depends on refId  →  item is blocked by refId, refId blocks item
      const blocks = blockedByThis.get(refId) ?? [];
      blocks.push(item.id);
      blockedByThis.set(refId, blocks);
      const bb = blockedBy.get(item.id) ?? [];
      bb.push(refId);
      blockedBy.set(item.id, bb);
    }
  }
  return { blockedByThis, blockedBy };
}

export function toCandidate(item: TodoItem): TodoCandidate {
  return {
    candidateId: item.id,
    item,
    signals: {},
    score: 0,
    blockedByThis: [],
    blockedBy: [],
  };
}
