/** ListOwnFeedback — the submitter's own tickets (spam hidden in the repo query). */
import type { AccountId } from '@cloudstudio/cloud-kernel';
import type { FeedbackSummary } from '../domain/feedback.js';
import type { FeedbackRepo } from '../domain/ports.js';

export class ListOwnFeedbackUseCase {
  constructor(private readonly repo: FeedbackRepo) {}
  async execute(input: { accountId: AccountId }): Promise<FeedbackSummary[]> {
    return this.repo.listByAccount(input.accountId);
  }
}
