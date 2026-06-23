/**
 * @cloudstudio/cloud-kernel — the shared kernel for the CodeStudio Cloud API.
 * Pure TypeScript, ZERO Cloudflare/Node deps: the domain + application layers
 * of every bounded context depend only on this. Infrastructure adapters
 * (D1/KV/R2/Email/Stripe) implement its ports.
 */
export * from './result.js';
export * from './errors.js';
export * from './ports.js';
export * from './ids.js';
