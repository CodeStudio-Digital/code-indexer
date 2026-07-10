/**
 * Prompt pré-pronto de cada etapa do App Studio + disparo: PATCH start
 * (best-effort — o servidor valida que é a etapa corrente) e injeção da
 * mensagem no chat via requestStudioSend. Textos em i18n
 * (appStudio.json, stageMessage.*) — escritos no idioma da UI e instruindo
 * o agente a espelhar o idioma do usuário.
 *
 * 'launch' não tem prompt: publicar é ação do PAINEL (launch chain), não
 * do chat.
 */
import type { TFunction } from 'i18next';
import { requestStudioSend } from '../builder/studio/studio-context-store.js';
import { patchAppStage, type AppStageId } from './app-studio-api.js';

export type PromptableStage = Exclude<AppStageId, 'launch'>;

const STAGE_MESSAGE_KEY: Record<PromptableStage, string> = {
  discovery: 'stageMessage.discovery',
  architecture: 'stageMessage.architecture',
  database: 'stageMessage.database',
  design: 'stageMessage.design',
  backend: 'stageMessage.backend',
  review: 'stageMessage.review',
};

export function isPromptableStage(stage: AppStageId): stage is PromptableStage {
  return stage !== 'launch';
}

export function stagePrompt(t: TFunction, stage: PromptableStage, extra?: string | null): string {
  const base = t(STAGE_MESSAGE_KEY[stage]);
  return extra?.trim() ? `${base}\n\n${extra.trim()}` : base;
}

/**
 * Dispara a etapa: marca 'start' no servidor (falha silenciosa — ex.: já
 * active) e manda o prompt para o chat. `extra` acrescenta contexto ao
 * prompt (ex.: a frase de ideia digitada na criação, na discovery).
 */
export async function startAppStage(
  t: TFunction,
  opts: { sessionId: number; projectId: number; stage: PromptableStage; extra?: string | null },
): Promise<void> {
  try {
    await patchAppStage(opts.sessionId, opts.stage, 'start');
  } catch {
    /* já active/fora de ordem — o chat ainda leva o prompt; o servidor manda no estado */
  }
  requestStudioSend(opts.projectId, stagePrompt(t, opts.stage, opts.extra));
}
