/**
 * Prompt pré-pronto de cada etapa do pipeline + disparo: PATCH start
 * (best-effort — o servidor valida que é a etapa corrente) e injeção da
 * mensagem no chat via requestStudioSend (mesmo mecanismo do Publicar).
 * Os textos vivem em i18n (designSystems.json, studio.stageMessage.*).
 */
import type { TFunction } from 'i18next';
import { requestStudioSend } from '../../builder/studio/studio-context-store.js';
import { patchPipelineStage, type DsStageId } from '../design-system-api.js';

const STAGE_MESSAGE_KEY: Record<DsStageId, string> = {
  analysis: 'studio.stageMessage.analyze',
  tokens: 'studio.stageMessage.tokens',
  primitives: 'studio.stageMessage.primitives',
  composites: 'studio.stageMessage.composites',
  templates: 'studio.stageMessage.templates',
  docs: 'studio.stageMessage.docs',
  publish: 'studio.publishMessage',
};

export function stagePrompt(t: TFunction, stage: DsStageId): string {
  return t(STAGE_MESSAGE_KEY[stage]);
}

/**
 * Dispara a etapa: marca 'start' no servidor (falha silenciosa — ex.: já
 * active) e manda o prompt para o chat. Retorna após o PATCH para o
 * caller poder dar refresh no detail.
 */
export async function startStage(
  t: TFunction,
  opts: { dsSessionId: number; projectId: number; stage: DsStageId },
): Promise<void> {
  try {
    await patchPipelineStage(opts.dsSessionId, opts.stage, 'start');
  } catch {
    /* já active/fora de ordem — o chat ainda leva o prompt; o servidor manda no estado */
  }
  requestStudioSend(opts.projectId, stagePrompt(t, opts.stage));
}
