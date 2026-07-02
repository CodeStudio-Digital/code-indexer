import { describe, expect, it } from 'vitest';
import {
  DS_STAGE_IDS,
  DsStageTransitionError,
  applyStageAction,
  applyStageSubmit,
  createPipelineState,
  currentStage,
  parsePipelineState,
  serializePipelineState,
} from '../pipeline/stages.js';
import { buildRoadmap, roadmapProgress } from '../pipeline/roadmap.js';
import type { ThemeDigestComponent } from '../theme-digest/theme-digest.js';

const GATE_OK = { ok: true, issues: [] };
const GATE_FAIL = { ok: false, issues: ['DESIGN_BRIEF.md not found'] };

function freshState() {
  return createPipelineState(buildRoadmap({ mode: 'creative' }), null);
}

describe('pipeline state', () => {
  it('starts with all 7 stages pending and analysis current', () => {
    const state = freshState();
    expect(state.stages.map((s) => s.id)).toEqual([...DS_STAGE_IDS]);
    expect(state.stages.every((s) => s.status === 'pending')).toBe(true);
    expect(currentStage(state)?.id).toBe('analysis');
  });

  it('round-trips through serialize/parse and rejects garbage', () => {
    const state = freshState();
    expect(parsePipelineState(serializePipelineState(state))?.stages).toHaveLength(7);
    expect(parsePipelineState('not json')).toBeNull();
    expect(parsePipelineState(JSON.stringify({ v: 2 }))).toBeNull();
    expect(parsePipelineState(null)).toBeNull();
  });
});

describe('stage transitions', () => {
  it('submit on the current stage: gate ok → review; user approves → next stage', () => {
    let state = freshState();
    state = applyStageSubmit(state, 'analysis', 'brief written', GATE_OK);
    expect(state.stages[0].status).toBe('review');
    expect(state.stages[0].summary).toBe('brief written');
    // ainda é a corrente até aprovar
    expect(currentStage(state)?.id).toBe('analysis');
    state = applyStageAction(state, 'analysis', 'approve');
    expect(state.stages[0].status).toBe('approved');
    expect(currentStage(state)?.id).toBe('tokens');
  });

  it('failed gate keeps the stage active for re-submit', () => {
    let state = freshState();
    state = applyStageSubmit(state, 'analysis', 'tried', GATE_FAIL);
    expect(state.stages[0].status).toBe('active');
    expect(state.stages[0].gate?.issues).toHaveLength(1);
  });

  it('rejects submitting a stage that is not current', () => {
    const state = freshState();
    expect(() => applyStageSubmit(state, 'tokens', 'x', GATE_OK)).toThrow(DsStageTransitionError);
  });

  it('reopen sends review back to active with feedback; skip advances', () => {
    let state = freshState();
    state = applyStageSubmit(state, 'analysis', 'v1', GATE_OK);
    state = applyStageAction(state, 'analysis', 'reopen', 'cores erradas');
    expect(state.stages[0].status).toBe('active');
    expect(state.stages[0].feedback).toBe('cores erradas');

    state = applyStageAction(state, 'analysis', 'skip');
    expect(currentStage(state)?.id).toBe('tokens');
  });

  it('start only applies to the current stage', () => {
    const state = freshState();
    expect(() => applyStageAction(state, 'docs', 'start')).toThrow(DsStageTransitionError);
    applyStageAction(state, 'analysis', 'start');
    expect(state.stages[0].status).toBe('active');
  });
});

describe('roadmap', () => {
  const digestButton: ThemeDigestComponent = {
    name: 'Btn',
    suggested_kind: 'atom',
    category: 'action',
    frequency: 12,
    confidence: 0.9,
    source_refs: ['index.html:42'],
  };
  const digestExotic: ThemeDigestComponent = {
    name: 'PricingCard',
    suggested_kind: 'atom',
    category: 'content',
    frequency: 3,
    confidence: 0.7,
    source_refs: ['pricing.html:10'],
  };

  it('marks catalog matches as digest-sourced (alias btn→Button) and appends exotics', () => {
    const roadmap = buildRoadmap({ mode: 'creative', digestComponents: [digestButton, digestExotic] });
    const button = roadmap.find((i) => i.name === 'Button')!;
    expect(button.source).toBe('digest');
    expect(button.source_refs).toEqual(['index.html:42']);
    const exotic = roadmap.find((i) => i.name === 'PricingCard')!;
    expect(exotic.tier).toBe('composite');
    expect(exotic.source).toBe('digest');
  });

  it('fidelity replaces default templates with digest pages', () => {
    const roadmap = buildRoadmap({
      mode: 'fidelity',
      digestComponents: [],
      digestPages: [
        { path: 'index.html', title: 'Corporate Home' },
        { path: 'pricing.html', title: null },
      ],
    });
    const templates = roadmap.filter((i) => i.tier === 'template');
    expect(templates.every((t) => t.source === 'digest')).toBe(true);
    expect(templates.map((t) => t.name)).toContain('CorporateHomeTemplate');
    expect(templates.map((t) => t.name)).toContain('PricingTemplate');
  });

  it('derives progress by case-insensitive name match', () => {
    const roadmap = buildRoadmap({ mode: 'creative' });
    const progress = roadmapProgress(roadmap, ['button', 'CARD']);
    expect(progress.find((p) => p.name === 'Button')?.recorded).toBe(true);
    expect(progress.find((p) => p.name === 'Card')?.recorded).toBe(true);
    expect(progress.find((p) => p.name === 'Input')?.recorded).toBe(false);
  });
});
