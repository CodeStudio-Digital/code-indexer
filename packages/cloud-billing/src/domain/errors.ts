/**
 * BillingError — the billing context's discriminated-union error, mirroring
 * `cloud-identity`'s `IdentityError`. Codes are stable + snake_case;
 * `billingHttpStatus` is the EXHAUSTIVE mapper the interface layer uses.
 */
import type { DomainError, HttpStatusMapper } from '@cloudstudio/cloud-kernel';

export type BillingError =
  | (DomainError & { code: 'billing_not_configured' })
  | (DomainError & { code: 'no_customer' })
  | (DomainError & { code: 'webhook_signature_invalid' });

type Code = BillingError['code'];

const STATUS: Record<Code, number> = {
  billing_not_configured: 501, // Stripe keys absent — the route is coded but inert.
  no_customer: 409,
  webhook_signature_invalid: 400,
};

export const billingHttpStatus: HttpStatusMapper<BillingError> = (e) => STATUS[e.code];

/** Terse, safe constructors (no provider internals leak to the client). */
export const BillingErrors = {
  notConfigured: (): BillingError => ({
    code: 'billing_not_configured',
    message: 'Billing is not configured.',
  }),
  noCustomer: (): BillingError => ({
    code: 'no_customer',
    message: 'No billing account yet. Start a subscription first.',
  }),
  webhookSignatureInvalid: (): BillingError => ({
    code: 'webhook_signature_invalid',
    message: 'Invalid webhook signature.',
  }),
};
