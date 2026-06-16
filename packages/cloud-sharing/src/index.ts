/**
 * @cloudstudio/cloud-sharing — public conversation sharing (bounded context).
 * Pure domain + application: a redaction engine (two-layer, fail-closed), an
 * Ed25519-signed denormalized snapshot, and an owner-managed read-only link.
 * Stripe entitlement gates creation; the public viewer reads ONLY the
 * denormalized, already-redacted snapshot — never the live conversation.
 */
export * from './domain/share.js';
export * from './domain/snapshot.js';
export * from './domain/errors.js';
export * from './domain/ports.js';
export * from './redaction/rules.js';
export * from './redaction/redactor.js';
export * from './application/create-share.js';
export * from './application/view-share.js';
