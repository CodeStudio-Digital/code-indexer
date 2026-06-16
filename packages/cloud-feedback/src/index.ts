/**
 * @cloudstudio/cloud-feedback — bug/idea/report intake (bounded context). Pure
 * domain + application. Authenticated or anonymous-with-Turnstile submission;
 * free-text is re-redacted through the shared sharing redactor; attachments are
 * Worker-proxied + magic-byte-sniffed into R2. Admin triage is deferred (needs a
 * role system) — this surface is the user-facing intake.
 */
export * from './domain/feedback.js';
export * from './domain/errors.js';
export * from './domain/ports.js';
export * from './application/submit-feedback.js';
export * from './application/attachments.js';
export * from './application/list-feedback.js';
