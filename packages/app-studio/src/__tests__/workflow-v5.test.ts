import { describe, expect, it } from 'vitest';
import { createAppWorkflowState, deriveAppWorkflowState } from '../workflow/state.js';
import { planAdaptiveDispatch, staleWorkItemsBySources } from '../workflow/scheduler.js';
import { migrateLegacyWorkflow } from '../workflow/migration.js';
import { parseLegacyPipeline } from '../workflow/legacy.js';
import { auditAppDeliveryBlueprint, auditAppReleaseReadiness } from '../workflow/audit.js';
import type { AppApproval, AppDeliveryBlueprint, AppWorkItem } from '../workflow/types.js';
import { stableRequirementSourceIds, upgradeAppSpecToV2 } from '../spec/stable-ids.js';
import { normalizeAppSpec } from '../spec/normalize.js';
import { diffAppSpecs } from '../spec/revisions.js';
import { parseAppAgentConfig, serializeAppAgentConfig } from '../workflow/agent-config.js';
import { makeSpec } from './fixtures.js';

const now = '2026-07-13T00:00:00.000Z';
function item(input: Partial<AppWorkItem> & Pick<AppWorkItem, 'id' | 'status'>): AppWorkItem {
  const base: AppWorkItem = {
    id: input.id, app_session_id: 1, phase: 'build', slice_id: null, title: input.id, outcome: input.id,
    kind: 'implement', owner_profile: 'implement', priority: 2, revision: 1, status: input.status, sort_order: 0,
    depends_on: [], source_ids: [], acceptance: [], evidence: [], file_scope: [], blocked_reason: null, run: null,
    created_at: now, updated_at: now,
  };
  return { ...base, ...input };
}
function approval(type: AppApproval['type'], status: AppApproval['status'], revision = 1): AppApproval {
  return { id: revision, app_session_id: 1, type, status, bundle_revision: revision, bundle: {}, summary: type, feedback: null, requested_at: now, resolved_at: status === 'pending' ? null : now };
}
function blueprint(workItemIds: string[]): AppDeliveryBlueprint {
  return {
    v: 1, refs: {},
    slices: [{ id: 'orders', capability_ids: [], journey_ids: [], source_ids: [], screen_ids: [], entity_names: [], behavior_ids: [], acceptance_test_ids: ['orders-works'], work_item_ids: workItemIds }],
    test_matrix: [{ id: 'orders-works', source_ids: [], slice_id: 'orders', kind: 'acceptance' }],
  };
}

describe('workflow v5', () => {
  it('moves through four phases and unlocks publishing only after Release', () => {
    const initial = createAppWorkflowState();
    expect(deriveAppWorkflowState(initial, [], []).phases.map((phase) => phase.status)).toEqual(['active', 'locked', 'locked', 'locked']);
    const scope = approval('scope', 'approved');
    expect(deriveAppWorkflowState(initial, [scope], []).phases.map((phase) => phase.status)).toEqual(['complete', 'active', 'locked', 'locked']);
    const blueprint = approval('blueprint', 'approved', 2);
    const done = item({ id: 'slice:done', status: 'done', evidence: [{ kind: 'test', value: 'green' }] });
    const readyForRelease = deriveAppWorkflowState(initial, [scope, blueprint], [done]);
    expect(readyForRelease.phases.map((phase) => phase.status)).toEqual(['complete', 'complete', 'complete', 'active']);
    const released = deriveAppWorkflowState(initial, [scope, blueprint, approval('release', 'approved', 3)], [done]);
    expect(released.release_unlocked).toBe(true);
    expect(released.phases.at(-1)?.status).toBe('complete');
  });

  it('keeps approvals pending without blocking independent ready cards', () => {
    const plan = planAdaptiveDispatch([
      item({ id: 'research', status: 'ready', kind: 'research', owner_profile: 'investigate' }),
      item({ id: 'waiting', status: 'blocked', blocked_reason: 'decision pending' }),
    ]);
    expect(plan.flat().map((candidate) => candidate.work_item_id)).toEqual(['research']);
  });

  it('serializes conflicting file scopes into separate waves', () => {
    const plan = planAdaptiveDispatch([
      item({ id: 'a', status: 'ready', file_scope: ['src/orders'] }),
      item({ id: 'b', status: 'ready', file_scope: ['src/orders/api.ts'] }),
      item({ id: 'c', status: 'ready', file_scope: ['src/users'] }),
    ]);
    expect(plan).toHaveLength(2);
    expect(plan[0]?.map((candidate) => candidate.work_item_id)).toEqual(['a', 'c']);
    expect(plan[1]?.map((candidate) => candidate.work_item_id)).toEqual(['b']);
  });

  it('keeps simple coordination inline and never treats cancellation as a completed dependency', () => {
    const plan = planAdaptiveDispatch([
      item({ id: 'coordinate', status: 'ready', kind: 'change', owner_profile: 'coordinator' }),
      item({ id: 'cancelled', status: 'cancelled' }),
      item({ id: 'dependent', status: 'ready', depends_on: ['cancelled'] }),
    ]);
    expect(plan.flat()).toEqual([{ work_item_id: 'coordinate', mode: 'inline', profile: 'coordinator' }]);
  });

  it('dispatches a separate verifier when its implementation dependency is in review', () => {
    const plan = planAdaptiveDispatch([
      item({ id: 'implement', status: 'review', owner_profile: 'ui' }),
      item({ id: 'verify', status: 'ready', kind: 'verify', owner_profile: 'verify', depends_on: ['implement'] }),
    ]);
    expect(plan.flat()).toEqual([{ work_item_id: 'verify', mode: 'subagent', profile: 'verify' }]);
  });

  it('invalidates only source-linked cards and their dependents', () => {
    const items = [
      item({ id: 'orders', status: 'done', source_ids: ['entity:orders'] }),
      item({ id: 'orders-review', status: 'done', depends_on: ['orders'] }),
      item({ id: 'users', status: 'done', source_ids: ['entity:users'] }),
    ];
    expect([...staleWorkItemsBySources(items, ['entity:orders'])].sort()).toEqual(['orders', 'orders-review']);
  });

  it('rejects Release when a Blueprint card was cancelled instead of completed', () => {
    const evidence = ['test', 'build', 'security', 'preview'].map((kind) => ({ kind, value: 'ok' }));
    const items = [
      item({ id: 'slice:cancelled', status: 'cancelled' }),
      item({ id: 'release:verify', phase: 'deliver', kind: 'release', status: 'done', evidence }),
    ];
    expect(auditAppReleaseReadiness(items, blueprint(['slice:cancelled'])).issues).toContain("Blueprint work item 'slice:cancelled' is cancelled, not done.");
    expect(auditAppReleaseReadiness([item({ id: 'slice:done', status: 'done' }), items[1]!], blueprint(['slice:done'])).ok).toBe(true);
  });

  it('requires every Blueprint source to reach a slice-local test and card', () => {
    const spec = upgradeAppSpecToV2(makeSpec({ requirements: { acceptance_criteria: ['Order can be saved'] } }));
    const acceptance = stableRequirementSourceIds(spec, 'acceptance')[0]!;
    const plan = blueprint(['slice:orders']);
    plan.slices[0]!.source_ids = ['feature:gestao-pedidos', acceptance];
    plan.test_matrix[0]!.source_ids = ['feature:gestao-pedidos', acceptance];
    const card = item({ id: 'slice:orders', status: 'ready', source_ids: ['feature:gestao-pedidos'] });
    expect(auditAppDeliveryBlueprint(plan, spec, null, [card]).issues).toContain(`No work item in the covering slice traces '${acceptance}'.`);
    card.source_ids.push(acceptance);
    expect(auditAppDeliveryBlueprint(plan, spec, null, [card]).ok).toBe(true);
  });

  it('reads the previous persisted format only for one-shot migration', () => {
    const legacy = parseLegacyPipeline(JSON.stringify({ v: 4, stages: [{ id: 'discovery', status: 'approved' }, { id: 'product', status: 'approved' }] }));
    expect(legacy).not.toBeNull();
    const migrated = migrateLegacyWorkflow({ app_session_id: 1, pipeline: legacy!, spec: makeSpec(), product: null, wireframe: null, build_groups: [], build_tasks: [], feature_names: ['Orders'], refs: {} });
    expect(migrated.state).toMatchObject({ v: 5, migrated_from: 4 });
    expect(migrated.approvals.find((candidate) => candidate.type === 'scope')?.status).toBe('approved');
    expect(migrated.work_items[0]).toMatchObject({ phase: 'build', status: 'done' });
  });
});

describe('App Studio agent configuration', () => {
  it('normalizes persisted coordinator and specialist prompts deterministically', () => {
    const parsed = parseAppAgentConfig({
      v: 99,
      coordinator_prompt: '  Preserve the current architecture.  ',
      coordinator_skills: [' browser ', 'browser', '', 42],
      profiles: {
        verify: { enabled: false, additional_prompt: '  Require focused tests.  ', skills: ['qa', ' browser '] },
        implement: { additional_prompt: 'Follow the file scope.', skills: ['cloudflare'] },
        '   ': { enabled: true, additional_prompt: 'ignored' },
      },
    });
    expect(parsed).toEqual({
      v: 1,
      coordinator_prompt: 'Preserve the current architecture.',
      coordinator_skills: ['browser'],
      profiles: {
        verify: { enabled: false, additional_prompt: 'Require focused tests.', skills: ['browser', 'qa'] },
        implement: { enabled: true, additional_prompt: 'Follow the file scope.', skills: ['cloudflare'] },
      },
    });
    expect(parseAppAgentConfig(serializeAppAgentConfig(parsed))).toEqual(parsed);
  });

  it('falls back safely for malformed legacy values', () => {
    expect(parseAppAgentConfig('{broken')).toEqual({ v: 1, coordinator_prompt: '', coordinator_skills: [], profiles: {} });
    expect(parseAppAgentConfig(null)).toEqual({ v: 1, coordinator_prompt: '', coordinator_skills: [], profiles: {} });
  });
});

describe('stable AppSpec ids', () => {
  it('keeps v1 ids readable and produces deterministic v2 ids', () => {
    const v1 = makeSpec({ requirements: { goals: ['Track orders'], acceptance_criteria: ['Order can be saved'] } });
    expect(stableRequirementSourceIds(v1, 'acceptance')).toEqual(['acceptance:0']);
    const first = upgradeAppSpecToV2(v1);
    const second = upgradeAppSpecToV2(makeSpec({ requirements: { goals: ['Track orders'], acceptance_criteria: ['Order can be saved'] } }));
    expect(stableRequirementSourceIds(first, 'acceptance')).toEqual(stableRequirementSourceIds(second, 'acceptance'));
    expect(stableRequirementSourceIds(first, 'acceptance')[0]).toMatch(/^acceptance:order-can-be-saved:/);
    expect((normalizeAppSpec(first) as { v: number }).v).toBe(2);
    const repairedV2 = upgradeAppSpecToV2({ ...first, requirement_ids: undefined });
    expect(repairedV2.requirement_ids?.acceptance?.[0]).toMatch(/^acceptance:order-can-be-saved:/);
    const duplicates = upgradeAppSpecToV2(makeSpec({ requirements: { acceptance_criteria: ['Same proof', 'Same proof'] } }));
    expect(new Set(duplicates.requirement_ids?.acceptance).size).toBe(2);
    const unchangedUpgrade = diffAppSpecs(v1, upgradeAppSpecToV2(v1));
    expect(unchangedUpgrade.changed_source_ids).not.toContain('acceptance:0');
    expect(unchangedUpgrade.changed_source_ids).toEqual([]);
  });
});
