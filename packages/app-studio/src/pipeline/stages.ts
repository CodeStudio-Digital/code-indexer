/**
 * Máquina de etapas do App Studio — o estado serializado em
 * `app_studio_sessions.pipeline_json` (schema versionado AQUI, v1).
 *
 * 6 etapas fixas: discovery → database → design → backend → review →
 * launch. Status por etapa: pending → active → review → approved
 * (+ skipped; reopen devolve para active com feedback). `current_stage` é
 * DERIVADO — primeira etapa não aprovada/pulada — nunca armazenado.
 *
 * O AGENTE avança via app_submit_stage (active → review, com gate); só o
 * USUÁRIO aprova (review → approved, via PATCH da UI — o agente não tem
 * tool de aprovação). A etapa launch é submetida pela launch chain
 * server-side (deploy iniciado pelo usuário no painel Publicar), nunca
 * pelo agente.
 *
 * Diferença vs DS Studio: o roadmap nasce VAZIO (a spec não existe no
 * scaffold) e é (re)construído por `app_save_spec` via `replaceRoadmap`.
 */
import type { AppRoadmapItem } from './roadmap.js';

export const APP_STAGE_IDS = [
  'discovery', 'database', 'design', 'backend', 'review', 'launch',
] as const;
export type AppStageId = (typeof APP_STAGE_IDS)[number];

export type AppStageStatus = 'pending' | 'active' | 'review' | 'approved' | 'skipped';
export type AppStageAction = 'start' | 'approve' | 'reopen' | 'skip';

export interface AppStageGateResult {
  ok: boolean;
  issues: string[];
}

export interface AppPipelineStage {
  id: AppStageId;
  status: AppStageStatus;
  /** Resumo do deliverable, escrito pelo agente no submit. */
  summary: string | null;
  /** Último resultado do gate determinístico (do submit que passou/falhou). */
  gate: AppStageGateResult | null;
  /** Feedback do usuário no reopen. */
  feedback: string | null;
  submitted_at: string | null;
  approved_at: string | null;
}

export interface AppPipelineState {
  v: 1;
  stages: AppPipelineStage[];
  roadmap: AppRoadmapItem[];
}

export function createPipelineState(): AppPipelineState {
  return {
    v: 1,
    stages: APP_STAGE_IDS.map((id) => ({
      id,
      status: 'pending',
      summary: null,
      gate: null,
      feedback: null,
      submitted_at: null,
      approved_at: null,
    })),
    roadmap: [],
  };
}

export function parsePipelineState(json: string | null | undefined): AppPipelineState | null {
  if (!json) return null;
  try {
    const state = JSON.parse(json) as AppPipelineState;
    if (state?.v !== 1 || !Array.isArray(state.stages)) return null;
    return state;
  } catch {
    return null;
  }
}

export function serializePipelineState(state: AppPipelineState): string {
  return JSON.stringify(state);
}

/** Primeira etapa não aprovada/pulada; null = pipeline concluído. */
export function currentStage(state: AppPipelineState): AppPipelineStage | null {
  return state.stages.find((s) => s.status !== 'approved' && s.status !== 'skipped') ?? null;
}

export class AppStageTransitionError extends Error {}

function stageOf(state: AppPipelineState, id: AppStageId): AppPipelineStage {
  const stage = state.stages.find((s) => s.id === id);
  if (!stage) throw new AppStageTransitionError(`Unknown stage '${id}'.`);
  return stage;
}

/**
 * Submit do AGENTE (app_submit_stage) — e da launch chain para 'launch':
 * exige que a etapa seja a corrente e grava resultado do gate; gate ok →
 * review, gate falho → permanece active (o agente corrige e re-submete).
 */
export function applyStageSubmit(
  state: AppPipelineState,
  id: AppStageId,
  summary: string,
  gate: AppStageGateResult,
): AppPipelineState {
  const current = currentStage(state);
  if (!current || current.id !== id) {
    throw new AppStageTransitionError(
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
  state: AppPipelineState,
  id: AppStageId,
  action: AppStageAction,
  feedback?: string | null,
): AppPipelineState {
  const stage = stageOf(state, id);
  const current = currentStage(state);
  switch (action) {
    case 'start':
      if (!current || current.id !== id) {
        throw new AppStageTransitionError(`Only the current stage can be started ('${current?.id ?? 'none'}').`);
      }
      if (stage.status === 'pending') stage.status = 'active';
      return state;
    case 'approve':
      // Only a stage the agent submitted (gate passed → review) can be
      // approved. Approving straight from 'active' would bypass the
      // deterministic gate AND, for discovery, could lock an empty spec
      // (app_save_spec refuses once discovery is approved) — a dead end.
      if (stage.status !== 'review') {
        throw new AppStageTransitionError(
          `Stage '${id}' is '${stage.status}' — only a stage in review can be approved.`,
        );
      }
      stage.status = 'approved';
      stage.approved_at = new Date().toISOString();
      return state;
    case 'reopen':
      if (stage.status !== 'review' && stage.status !== 'approved') {
        throw new AppStageTransitionError(`Stage '${id}' is '${stage.status}' — nothing to reopen.`);
      }
      stage.status = 'active';
      stage.approved_at = null;
      stage.feedback = feedback?.trim() || null;
      return state;
    case 'skip':
      if (stage.status === 'approved') {
        throw new AppStageTransitionError(`Stage '${id}' is already approved.`);
      }
      stage.status = 'skipped';
      return state;
    default:
      throw new AppStageTransitionError(`Unknown action '${String(action)}'.`);
  }
}

/**
 * Substitui o roadmap (chamado por app_save_spec a cada save da spec). O
 * bloqueio "spec travada após discovery aprovado" é responsabilidade da
 * tool — esta função é manipulação pura de estado.
 */
export function replaceRoadmap(state: AppPipelineState, roadmap: AppRoadmapItem[]): AppPipelineState {
  state.roadmap = roadmap;
  return state;
}
