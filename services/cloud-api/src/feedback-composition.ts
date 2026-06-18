/** Feedback composition root — D1 repo + R2 store + Turnstile + sniffer → use-cases. */
import { CreateAttachmentUseCase, ListOwnFeedbackUseCase, SubmitFeedbackUseCase } from '@cloudstudio/cloud-feedback';
import { createD1Executor } from './infra/d1/d1-executor.js';
import { createFeedbackRepo } from './infra/d1/feedback-repo.js';
import { createAttachmentStore } from './infra/r2-attachment-store.js';
import { createContentSniffer } from './infra/content-sniffer.js';
import { createBotVerifier } from './infra/turnstile.js';
import { cryptoIdGen, systemClock } from './infra/runtime.js';
import type { Env } from './env.js';

export interface FeedbackBundle {
  submit: SubmitFeedbackUseCase;
  createAttachment: CreateAttachmentUseCase;
  list: ListOwnFeedbackUseCase;
  anonymousEnabled: boolean;
}

export function createFeedbackBundle(env: Env): FeedbackBundle {
  const db = createD1Executor(env.DB);
  const repo = createFeedbackRepo(db);
  const store = createAttachmentStore(env.ASSETS);
  const sniffer = createContentSniffer();
  const bot = createBotVerifier(env.TURNSTILE_SECRET);
  return {
    submit: new SubmitFeedbackUseCase(repo, bot, cryptoIdGen, systemClock),
    createAttachment: new CreateAttachmentUseCase(repo, store, sniffer, cryptoIdGen, systemClock),
    list: new ListOwnFeedbackUseCase(repo),
    anonymousEnabled: bot.enabled,
  };
}
