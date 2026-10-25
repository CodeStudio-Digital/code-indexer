export interface CodeRunRolloutEntry {
  key: string;
  owner: string;
  introducedAt: string;
  expiresAt: string;
  promotionMetric: string;
  rollbackReceipt: string;
  canaryStages: readonly string[];
  stopConditions: readonly string[];
  receiptPrefix: string;
  retirementAction: 'bake_default_and_remove_switch' | 'remove_shadow_switch';
}

export const REQUIRED_CODE_RUN_CANARY_STAGES = Object.freeze([
  'internal', '1%', '5%', '25%', '50%', '100%',
]);

export const REQUIRED_CODE_RUN_STOP_CONDITIONS = Object.freeze([
  'session_loss_or_corruption',
  'policy_or_fence_bypass',
  'process_or_resource_leak',
  'duplicate_or_false_terminal_effect',
  'material_success_latency_cost_regression',
]);

const receiptPrefix = (key: string): string => (
  `docs/architecture/code-run-refactor/results/rollouts/${key}`
);
const RETIREMENT_ACTIONS = new Set([
  'bake_default_and_remove_switch',
  'remove_shadow_switch',
]);

/**
 * Temporary code-run env controls. CI rejects an undeclared or expired entry,
 * preventing a rollout switch from silently becoming permanent product API.
 * The four runtime-migration switches were retired on 2026-10-24; see
 * docs/architecture/runtime-retirement.md. Keep validation for future rollouts
 * and reject reintroduced consumers of the retired switches as undeclared.
 */
export const CODE_RUN_ROLLOUT_MANIFEST: readonly CodeRunRolloutEntry[] = Object.freeze([]);

export interface RolloutManifestValidation {
  ok: boolean;
  missing: string[];
  expired: string[];
  duplicate: string[];
  invalid: string[];
}

export function validateCodeRunRolloutManifest(
  observedKeys: readonly string[],
  now = new Date(),
): RolloutManifestValidation {
  return validateCodeRunRolloutEntries(CODE_RUN_ROLLOUT_MANIFEST, observedKeys, now);
}

export function validateCodeRunRolloutEntries(
  entries: readonly CodeRunRolloutEntry[],
  observedKeys: readonly string[],
  now = new Date(),
): RolloutManifestValidation {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1);
  }
  const duplicate = [...counts].filter(([, count]) => count > 1).map(([key]) => key).sort();
  const declared = new Map(entries.map((entry) => [entry.key, entry]));
  const missing = [...new Set(observedKeys)].filter((key) => !declared.has(key)).sort();
  const today = now.toISOString().slice(0, 10);
  const expired = [...new Set(observedKeys)]
    .filter((key) => {
      const entry = declared.get(key);
      return entry ? entry.expiresAt < today : false;
    })
    .sort();
  const invalid = entries.filter((entry) => (
    !/^CODER_[A-Z0-9_]+$/u.test(entry.key)
    || entry.owner.trim().length === 0
    || !/^\d{4}-\d{2}-\d{2}$/u.test(entry.introducedAt)
    || !/^\d{4}-\d{2}-\d{2}$/u.test(entry.expiresAt)
    || entry.introducedAt > entry.expiresAt
    || entry.promotionMetric.trim().length === 0
    || entry.rollbackReceipt.trim().length === 0
    || entry.receiptPrefix !== receiptPrefix(entry.key)
    || !RETIREMENT_ACTIONS.has(entry.retirementAction)
    || !sameOrderedValues(entry.canaryStages, REQUIRED_CODE_RUN_CANARY_STAGES)
    || !sameOrderedValues(entry.stopConditions, REQUIRED_CODE_RUN_STOP_CONDITIONS)
  )).map((entry) => entry.key).sort();
  return {
    ok: missing.length === 0
      && expired.length === 0
      && duplicate.length === 0
      && invalid.length === 0,
    missing,
    expired,
    duplicate,
    invalid,
  };
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
