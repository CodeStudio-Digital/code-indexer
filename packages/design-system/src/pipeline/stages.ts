/**
 * Máquina de etapas do DS Studio — o estado serializado em
 * `design_system_sessions.pipeline_json` (schema versionado AQUI, v1).
 *
 * 7 etapas fixas: analysis → tokens → primitives → composites → templates →
 * docs → publish. Status por etapa: pending → active → review → approved
 * (+ skipped; reopen devolve para active com feedback). `current_stage` é
 * DERIVADO — primeira etapa não aprovada/pulada — nunca armazenado.
 *
 * O AGENTE avança via ds_submit_stage (active → review, com gate); só o
 * USUÁRIO aprova (review → approved, via PATCH da UI — o agente não tem
 * tool de aprovação).
 */
import type { DsRoadmapItem } from './roadmap.js';
import type { ThemeDigestSummary } from '../theme-digest/theme-digest.js';

export const DS_STAGE_IDS = [
  'analysis', 'tokens', 'primitives', 'composites', 'templates', 'docs', 'publish',
] as const;
export type DsStageId = (typeof DS_STAGE_IDS)[number];

export type DsStageStatus = 'pending' | 'active' | 'review' | 'approved' | 'skipped';
export type DsStageAction = 'start' | 'approve' | 'reopen' | 'skip';

export interface DsStageGateResult {
  ok: boolean;
  issues: string[];
}

export interface DsPipelineStage {
  id: DsStageId;
  status: DsStageStatus;
  /** Resumo do deliverable, escrito pelo agente no submit. */
  summary: string | null;
  /** Último resultado do gate determinístico (do submit que passou/falhou). */
  gate: DsStageGateResult | null;
  /** Feedback do usuário no reopen. */
  feedback: string | null;
  submitted_at: string | null;
  approved_at: string | null;
}

export interface DsPipelineState {
  v: 1;
  stages: DsPipelineStage[];
  roadmap: DsRoadmapItem[];
  theme_digest: ThemeDigestSummary | null;
}

export function createPipelineState(
  roadmap: DsRoadmapItem[],
  themeDigest: ThemeDigestSummary | null,
): DsPipelineState {
  return {
    v: 1,
    stages: DS_STAGE_IDS.map((id) => ({
      id,
      status: 'pending',
      summary: null,
      gate: null,
      feedback: null,
      submitted_at: null,
      approved_at: null,
    })),
    roadmap,
    theme_digest: themeDigest,
  };
}

export function parsePipelineState(json: string | null | undefined): DsPipelineState | null {
  if (!json) return null;
  try {
    const state = JSON.parse(json) as DsPipelineState;
    if (state?.v !== 1 || !Array.isArray(state.stages)) return null;
    return state;
  } catch {
    return null;
  }
}

export function serializePipelineState(state: DsPipelineState): string {
  return JSON.stringify(state);
}

/** Primeira etapa não aprovada/pulada; null = pipeline concluído. */
export function currentStage(state: DsPipelineState): DsPipelineStage | null {
  return state.stages.find((s) => s.status !== 'approved' && s.status !== 'skipped') ?? null;
}

export class DsStageTransitionError extends Error {}

function stageOf(state: DsPipelineState, id: DsStageId): DsPipelineStage {
  const stage = state.stages.find((s) => s.id === id);
  if (!stage) throw new DsStageTransitionError(`Unknown stage '${id}'.`);
  return stage;
}

/**
 * Submit do AGENTE (ds_submit_stage): exige que a etapa seja a corrente e
 * grava resultado do gate; gate ok → review, gate falho → permanece
 * active (o agente corrige e re-submete).
 */
export function applyStageSubmit(
  state: DsPipelineState,
  id: DsStageId,
  summary: string,
  gate: DsStageGateResult,
): DsPipelineState {
  const current = currentStage(state);
  if (!current || current.id !== id) {
    throw new DsStageTransitionError(
      `Stage '${id}' is not the current stage${current ? ` (current: '${current.id}')` : ' (pipeline complete)'}. ` +
        'Work the stages in order.',
    );
  }
  const stage = stageOf(state, id);
  stage.summary = summary;
  stage.gate = gate;
  stage.submitted_at = new Date().toISOString();
  stage.status = gate.ok ? 'review' : 'active';
  return state;
}

/** Ações do USUÁRIO (PATCH da UI): start/approve/reopen/skip. */
export function applyStageAction(
  state: DsPipelineState,
  id: DsStageId,
  action: DsStageAction,
  feedback?: string | null,
): DsPipelineState {
  const stage = stageOf(state, id);
  const current = currentStage(state);
  switch (action) {
    case 'start':
      if (!current || current.id !== id) {
        throw new DsStageTransitionError(`Only the current stage can be started ('${current?.id ?? 'none'}').`);
      }
      if (stage.status === 'pending') stage.status = 'active';
      return state;
    case 'approve':
      if (stage.status !== 'review' && stage.status !== 'active') {
        throw new DsStageTransitionError(`Stage '${id}' is '${stage.status}' — nothing to approve.`);
      }
      stage.status = 'approved';
      stage.approved_at = new Date().toISOString();
      return state;
    case 'reopen':
      if (stage.status !== 'review' && stage.status !== 'approved') {
        throw new DsStageTransitionError(`Stage '${id}' is '${stage.status}' — nothing to reopen.`);
      }
      stage.status = 'active';
      stage.approved_at = null;
      stage.feedback = feedback?.trim() || null;
      return state;
    case 'skip':
      if (stage.status === 'approved') {
        throw new DsStageTransitionError(`Stage '${id}' is already approved.`);
      }
      stage.status = 'skipped';
      return state;
    default:
      throw new DsStageTransitionError(`Unknown action '${String(action)}'.`);
  }
}
