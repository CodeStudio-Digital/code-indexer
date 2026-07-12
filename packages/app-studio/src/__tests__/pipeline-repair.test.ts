import { describe, expect, it } from 'vitest';
import { makeSpec } from './fixtures.js';
import { repairAppPipeline } from '../pipeline/repair.js';
import { createPipelineState } from '../pipeline/stages.js';
import { buildFeatureRoadmap } from '../pipeline/roadmap.js';

const evidence = (overrides = {}) => ({
  spec: makeSpec(),
  approvedSpecRevisionId: 10,
  product: null,
  architecture: null,
  deployHealthy: false,
  ...overrides,
});

describe('App Studio pipeline auto repair', () => {
  it('inserts product modeling before legacy downstream work without touching artifacts', () => {
    const state = createPipelineState();
    state.stages[0]!.status = 'approved';
    state.stages[2]!.status = 'skipped';
    state.stages[2]!.summary = 'Etapa adicionada depois que este app ja estava em construcao.';
    state.stages[3]!.status = 'active';
    const report = repairAppPipeline(state, evidence());
    expect(report.pipeline.stages.map((stage) => stage.status)).toEqual([
      'approved', 'active', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending',
    ]);
    expect(report.changes).toContainEqual(expect.objectContaining({ stage_id: 'product', after: 'active' }));
  });

  it('rebuilds missing stages and the roadmap from the current spec', () => {
    const state = createPipelineState();
    state.stages = state.stages.filter((stage) => stage.id !== 'design');
    state.roadmap = [];
    const report = repairAppPipeline(state, evidence({ approvedSpecRevisionId: null }));
    expect(report.pipeline.stages.map((stage) => stage.id)).toEqual([
      'discovery', 'product', 'architecture', 'database', 'ux', 'wireframe', 'design', 'backend', 'review', 'launch',
    ]);
    expect(report.pipeline.roadmap).toEqual(buildFeatureRoadmap(makeSpec()));
    expect(report.issues.map((issue) => issue.code)).toContain('missing-stage');
    expect(report.issues.map((issue) => issue.code)).toContain('stale-roadmap');
  });

  it('preserves trustworthy approved architecture and a current database stage', () => {
    const state = createPipelineState();
    state.roadmap = buildFeatureRoadmap(makeSpec());
    state.stages[0]!.status = 'approved';
    state.stages[1]!.status = 'approved';
    state.stages[2]!.status = 'approved';
    state.stages[3]!.status = 'active';
    const report = repairAppPipeline(state, evidence({
      product: { revisionId: 15, status: 'approved', baseSpecRevisionId: 10, resultSpecRevisionId: 10, auditOk: true },
      architecture: { revisionId: 20, status: 'approved', specRevisionId: 10, auditOk: true },
    }));
    expect(report.changed).toBe(false);
    expect(report.changes).toEqual([]);
  });

  it('downgrades an approval without gate evidence and resets later stages', () => {
    const state = createPipelineState();
    state.stages[0]!.status = 'approved';
    state.stages[1]!.status = 'approved';
    state.stages[2]!.status = 'approved';
    state.stages[3]!.status = 'approved';
    state.stages[4]!.status = 'active';
    const report = repairAppPipeline(state, evidence({
      product: { revisionId: 15, status: 'approved', baseSpecRevisionId: 10, resultSpecRevisionId: 10, auditOk: true },
      architecture: { revisionId: 20, status: 'approved', specRevisionId: 10, auditOk: true },
    }));
    expect(report.pipeline.stages[3]!.status).toBe('active');
    expect(report.pipeline.stages[4]!.status).toBe('pending');
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'missing-evidence', stage_id: 'database' }));
  });

  it('upgrades a legacy v2 journey opt-in and returns it to UX without deleting completed screens', () => {
    const legacy = createPipelineState();
    legacy.v = 2;
    legacy.stages = legacy.stages.filter((stage) => stage.id !== 'ux' && stage.id !== 'wireframe');
    legacy.roadmap = buildFeatureRoadmap(makeSpec());
    for (const id of ['discovery', 'architecture', 'database', 'design'] as const) {
      const stage = legacy.stages.find((item) => item.id === id)!;
      stage.status = 'approved';
      stage.gate = { ok: true, issues: [] };
      stage.summary = `${id} existente`;
    }
    const report = repairAppPipeline(legacy, evidence({
      product: { revisionId: 15, status: 'approved', baseSpecRevisionId: 10, resultSpecRevisionId: 10, auditOk: true },
      architecture: { revisionId: 20, status: 'approved', specRevisionId: 10, auditOk: true },
    }));
    expect(report.pipeline.v).toBe(4);
    expect(report.pipeline.stages.find((stage) => stage.id === 'ux')).toMatchObject({ status: 'active' });
    expect(report.pipeline.stages.find((stage) => stage.id === 'design')).toMatchObject({ status: 'pending' });
    expect(report.pipeline.roadmap).toEqual(legacy.roadmap);
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'missing-stage', stage_id: 'ux' }));
  });
});
