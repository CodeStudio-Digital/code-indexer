import { describe, expect, it } from 'vitest';
import {
  APP_STAGE_IDS,
  AppStageTransitionError,
  applyStageAction,
  applyStageSubmit,
  createPipelineState,
  currentStage,
  parsePipelineState,
  replaceRoadmap,
  serializePipelineState,
} from '../pipeline/stages.js';
import { buildFeatureRoadmap, roadmapProgress } from '../pipeline/roadmap.js';
import { makeSpec } from './fixtures.js';

const GATE_OK = { ok: true, issues: [] };
const GATE_FAIL = { ok: false, issues: ['spec missing'] };

describe('pipeline state', () => {
  it('starts with all 6 stages pending, empty roadmap and discovery current', () => {
    const state = createPipelineState();
    expect(state.stages.map((s) => s.id)).toEqual([...APP_STAGE_IDS]);
    expect(state.stages.every((s) => s.status === 'pending')).toBe(true);
    expect(state.roadmap).toEqual([]);
    expect(currentStage(state)?.id).toBe('discovery');
  });

  it('round-trips through serialize/parse and rejects garbage', () => {
    const state = createPipelineState();
    expect(parsePipelineState(serializePipelineState(state))?.stages).toHaveLength(6);
    expect(parsePipelineState('not json')).toBeNull();
    expect(parsePipelineState(JSON.stringify({ v: 2 }))).toBeNull();
    expect(parsePipelineState(null)).toBeNull();
  });
});

describe('stage transitions', () => {
  it('submit on the current stage: gate ok → review; user approves → next stage', () => {
    let state = createPipelineState();
    state = applyStageSubmit(state, 'discovery', 'spec saved', GATE_OK);
    expect(state.stages[0].status).toBe('review');
    expect(currentStage(state)?.id).toBe('discovery');
    state = applyStageAction(state, 'discovery', 'approve');
    expect(state.stages[0].status).toBe('approved');
    expect(currentStage(state)?.id).toBe('database');
  });

  it('failed gate keeps the stage active for re-submit', () => {
    let state = createPipelineState();
    state = applyStageSubmit(state, 'discovery', 'tried', GATE_FAIL);
    expect(state.stages[0].status).toBe('active');
    expect(state.stages[0].gate?.issues).toHaveLength(1);
  });

  it('rejects submitting a stage that is not current', () => {
    const state = createPipelineState();
    expect(() => applyStageSubmit(state, 'design', 'x', GATE_OK)).toThrow(AppStageTransitionError);
  });

  it('reopen sends review back to active with feedback; skip advances', () => {
    let state = createPipelineState();
    state = applyStageSubmit(state, 'discovery', 'v1', GATE_OK);
    state = applyStageAction(state, 'discovery', 'reopen', 'faltou a tela de clientes');
    expect(state.stages[0].status).toBe('active');
    expect(state.stages[0].feedback).toBe('faltou a tela de clientes');

    state = applyStageAction(state, 'discovery', 'skip');
    expect(currentStage(state)?.id).toBe('database');
  });

  it('start only applies to the current stage', () => {
    const state = createPipelineState();
    expect(() => applyStageAction(state, 'review', 'start')).toThrow(AppStageTransitionError);
    applyStageAction(state, 'discovery', 'start');
    expect(state.stages[0].status).toBe('active');
  });

  it('approve is refused from active (only a stage in review can be approved)', () => {
    const state = createPipelineState();
    applyStageAction(state, 'discovery', 'start'); // pending → active
    expect(state.stages[0].status).toBe('active');
    // Approving an active (un-submitted) stage would bypass the gate and,
    // for discovery, lock an empty spec — must throw.
    expect(() => applyStageAction(state, 'discovery', 'approve')).toThrow(AppStageTransitionError);
    // Only after a passing submit (→ review) can it be approved.
    applyStageSubmit(state, 'discovery', 'ok', GATE_OK);
    applyStageAction(state, 'discovery', 'approve');
    expect(state.stages[0].status).toBe('approved');
  });
});

describe('roadmap', () => {
  it('builds screen items per spec screen and api items per entity', () => {
    const roadmap = buildFeatureRoadmap(makeSpec());
    expect(roadmap).toEqual([
      { name: 'PainelScreen', tier: 'screen', feature_id: 'gestao-pedidos', source: 'spec' },
      { name: 'pedidos', tier: 'api', feature_id: null, source: 'spec' },
    ]);
  });

  it('adds screenless features as api items, skipping entity name collisions', () => {
    const spec = makeSpec({
      features: [
        { id: 'gestao-pedidos', name: 'Gestão de pedidos', description: 'x', screen_ids: ['painel'] },
        { id: 'relatorio', name: 'Relatório semanal', description: 'gera resumo', screen_ids: [] },
        { id: 'dup', name: 'Pedidos', description: 'colide com a entity', screen_ids: [] },
      ],
    });
    const roadmap = buildFeatureRoadmap(spec);
    const api = roadmap.filter((i) => i.tier === 'api').map((i) => i.name);
    expect(api).toEqual(['pedidos', 'Relatório semanal']);
  });

  it('replaceRoadmap swaps the roadmap in place', () => {
    const state = createPipelineState();
    replaceRoadmap(state, buildFeatureRoadmap(makeSpec()));
    expect(state.roadmap).toHaveLength(2);
  });

  it('derives progress tier-aware: screen records never cover api items', () => {
    const roadmap = buildFeatureRoadmap(makeSpec());
    const progress = roadmapProgress(roadmap, [
      { name: 'painelscreen', kind: 'screen' },
      { name: 'Pedidos', kind: 'screen' },
    ]);
    expect(progress.find((p) => p.name === 'PainelScreen')?.recorded).toBe(true);
    expect(progress.find((p) => p.name === 'pedidos')?.recorded).toBe(false);
  });
});
