/**
 * Resolve an account's entitlements. On first cloud use (no subscription row),
 * auto-grant a one-shot 14-day Pro trial. Always re-derives from live state.
 */
import type { AccountId, Clock } from '@cloudstudio/cloud-kernel';
import { deriveEntitlements, TRIAL_DAYS, type Entitlements } from '../domain/entitlements.js';
import type { BillingRepo } from '../domain/ports.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export class GetEntitlementsUseCase {
  constructor(
    private readonly billing: BillingRepo,
    private readonly clock: Clock,
  ) {}

  async execute(input: { accountId: AccountId }): Promise<Entitlements> {
    const now = this.clock.now();
    let sub = await this.billing.getSubscription(input.accountId);
    if (!sub) {
      // First cloud touch → grant the one-shot trial, then re-read. Re-read even
      // if startTrial reports false (a concurrent request may have created it).
      await this.billing.startTrial(input.accountId, now + TRIAL_DAYS * DAY_MS);
      sub = await this.billing.getSubscription(input.accountId);
    }
    return deriveEntitlements(sub, now);
  }
}
