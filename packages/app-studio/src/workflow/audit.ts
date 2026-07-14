import type { AppProductModel } from '../product/types.js';
import type { AppSpec } from '../spec/types.js';
import { stableRequirementSourceIds } from '../spec/stable-ids.js';
import type { AppDeliveryBlueprint, AppWorkItem } from './types.js';

export interface AppDeliveryBlueprintAudit {
  ok: boolean;
  issues: string[];
}

export interface AppReleaseReadinessAudit { ok: boolean; issues: string[] }

export function auditAppReleaseReadiness(workItems: AppWorkItem[], blueprint: AppDeliveryBlueprint | null): AppReleaseReadinessAudit {
  const issues: string[] = [];
  const deliveryItems = workItems.filter((item) => item.phase === 'deliver');
  const unfinished = workItems.filter((item) => (item.phase === 'build' || item.phase === 'deliver') && !['done', 'cancelled'].includes(item.status));
  if (unfinished.length > 0) issues.push(`${unfinished.length} build/delivery card(s) are unfinished.`);
  if (deliveryItems.length === 0) issues.push('No delivery verification card exists.');
  if (!blueprint) {
    issues.push('No approved delivery blueprint is available for release traceability.');
  } else {
    const byId = new Map(workItems.map((item) => [item.id, item]));
    const referenced = [...new Set(blueprint.slices.flatMap((slice) => slice.work_item_ids))];
    for (const id of referenced) {
      const item = byId.get(id);
      if (!item) issues.push(`Blueprint work item '${id}' no longer exists.`);
      else if (item.status !== 'done') issues.push(`Blueprint work item '${id}' is ${item.status}, not done.`);
    }
  }
  const completed = workItems.filter((item) => item.status === 'done');
  const kinds = completed.flatMap((item) => item.evidence.map((evidence) => evidence.kind.toLowerCase()));
  for (const required of ['test', 'build', 'security', 'preview']) {
    if (!kinds.some((kind) => kind.includes(required))) issues.push(`Release evidence '${required}' is missing.`);
  }
  return { ok: issues.length === 0, issues };
}

export function auditAppDeliveryBlueprint(
  blueprint: AppDeliveryBlueprint | null,
  spec: AppSpec | null,
  product: AppProductModel | null,
  workItems: AppWorkItem[],
): AppDeliveryBlueprintAudit {
  const issues: string[] = [];
  if (!blueprint) return { ok: false, issues: ['No delivery blueprint saved.'] };
  if (!spec) return { ok: false, issues: ['App spec is missing.'] };
  const sliceIds = new Set(blueprint.slices.map((slice) => slice.id));
  const itemIds = new Set(workItems.map((item) => item.id));
  const selectedCapabilities = product?.capabilities.filter((item) => item.selected && item.horizon !== 'declined') ?? [];
  const requiredSources = [
    ...spec.features.map((feature) => `feature:${feature.id}`),
    ...stableRequirementSourceIds(spec, 'acceptance'),
    ...selectedCapabilities.map((capability) => `capability:${capability.id}`),
  ];
  for (const source of requiredSources) {
    const coveringSlices = blueprint.slices.filter((slice) => slice.source_ids.includes(source));
    if (coveringSlices.length === 0) {
      issues.push(`No vertical slice covers '${source}'.`);
      continue;
    }
    const coveringSliceIds = new Set(coveringSlices.map((slice) => slice.id));
    if (!blueprint.test_matrix.some((test) => coveringSliceIds.has(test.slice_id) && test.source_ids.includes(source))) {
      issues.push(`No acceptance test in the covering slice traces '${source}'.`);
    }
    const linkedItemIds = new Set(coveringSlices.flatMap((slice) => slice.work_item_ids));
    if (!workItems.some((item) => linkedItemIds.has(item.id) && item.source_ids.includes(source))) {
      issues.push(`No work item in the covering slice traces '${source}'.`);
    }
  }
  for (const slice of blueprint.slices) {
    if (!slice.id || slice.work_item_ids.length === 0) issues.push(`Slice '${slice.id || '?'}' has no work items.`);
    for (const itemId of slice.work_item_ids) if (!itemIds.has(itemId)) issues.push(`Slice '${slice.id}' references unknown work item '${itemId}'.`);
    if (slice.acceptance_test_ids.length === 0) issues.push(`Slice '${slice.id}' has no acceptance test.`);
  }
  for (const test of blueprint.test_matrix) if (!sliceIds.has(test.slice_id)) issues.push(`Test '${test.id}' references unknown slice '${test.slice_id}'.`);
  return { ok: issues.length === 0, issues: [...new Set(issues)] };
}
