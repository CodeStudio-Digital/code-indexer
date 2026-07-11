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
export type AppStudioStageSpecialist = 'spec' | 'db' | 'architecture' | 'ux' | 'wireframe' | 'design' | 'backend' | 'review';

const STAGE_MESSAGE_KEY: Record<PromptableStage, string> = {
  discovery: 'stageMessage.discovery',
  architecture: 'stageMessage.architecture',
  database: 'stageMessage.database',
  ux: 'stageMessage.ux',
  wireframe: 'stageMessage.wireframe',
  design: 'stageMessage.design',
  backend: 'stageMessage.backend',
  review: 'stageMessage.review',
};

const STAGE_SPECIALIST: Partial<Record<PromptableStage, AppStudioStageSpecialist>> = {
  discovery: 'spec',
  architecture: 'architecture',
  database: 'db',
  ux: 'ux',
  wireframe: 'wireframe',
  design: 'design',
  backend: 'backend',
  review: 'review',
};

export function isPromptableStage(stage: AppStageId): stage is PromptableStage {
  return stage !== 'launch';
}

export function stagePrompt(t: TFunction, stage: PromptableStage, extra?: string | null): string {
  const base = t(STAGE_MESSAGE_KEY[stage]);
  return extra?.trim() ? `${base}\n\n${extra.trim()}` : base;
}

export function specialistForStage(stage: AppStageId): AppStudioStageSpecialist | null {
  return isPromptableStage(stage) ? STAGE_SPECIALIST[stage] ?? null : null;
}

export async function activateAppStage(sessionId: number, stage: PromptableStage): Promise<void> {
  try {
    await patchAppStage(sessionId, stage, 'start');
  } catch {
    /* A etapa já pode estar ativa; abrir o especialista continua válido. */
  }
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
  await activateAppStage(opts.sessionId, opts.stage);
  requestStudioSend(opts.projectId, stagePrompt(t, opts.stage, opts.extra));
}
