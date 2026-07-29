import type {
  CompanySandboxStore,
} from '@mcp/store/company-sandbox-store.js';
import type {
  CompanySandboxServicesStore,
} from '@mcp/store/company-sandbox-services-store.js';
import type { CompanySessionEnvStore } from '@mcp/store/company-session-env-store.js';
import {
  importDotEnvIntoStore as importDotEnvIntoStoreFrom,
  resolveSessionEnvs as resolveSessionEnvsFrom,
} from '../manager/io/env-helpers.js';
import { sandboxStores } from '../manager/state/stores.js';

/**
 * Module-level binding of the persistence store. The SandboxManager singleton
 * is constructed lazily via `getSandboxManager()`, but the DB-backed store
 * comes from `createDeps()` at server boot — LATER. We use setter + lazy
 * getter so the manager works even when the store is absent (tests, CLI,
 * non-HTTP paths) and transparently persists state when the store IS present.
 */
let sandboxStore: CompanySandboxStore | null = null;
let servicesStore: CompanySandboxServicesStore | null = null;
let envStore: CompanySessionEnvStore | null = null;

/**
 * QA preview-routing configuration injected at boot. Holds just the port the
 * http-api process is listening on so `syncManagedEnvs` can compose
 * `PLAYWRIGHT_BASE_URL_*` URLs that point at the proxy from inside a sibling
 * container.
 */
let qaPreviewConfig: {
  httpApiPort: number;
  hasQaPlaywrightSkill: (sessionId: string) => boolean;
} | null = null;

export function setCompanySandboxStore(store: CompanySandboxStore | null): void {
  sandboxStore = store;
  sandboxStores.setSandboxStore(store);
}

export function setCompanySandboxServicesStore(
  store: CompanySandboxServicesStore | null,
): void {
  servicesStore = store;
  sandboxStores.setServicesStore(store);
}

export function setCompanySessionEnvStore(
  store: CompanySessionEnvStore | null,
): void {
  envStore = store;
  sandboxStores.setEnvStore(store);
}

/**
 * Wire the QA preview-URL routing config. Called from `server.ts` at boot
 * once `IndexerConfig` has been loaded and the company store is available.
 */
export function setQaPreviewConfig(
  cfg: {
    httpApiPort: number;
    hasQaPlaywrightSkill: (sessionId: string) => boolean;
  } | null,
): void {
  qaPreviewConfig = cfg;
  sandboxStores.setQaPreviewConfig(cfg);
}

export function getStore(): CompanySandboxStore | null { return sandboxStore; }
export function getServicesStore(): CompanySandboxServicesStore | null { return servicesStore; }
export function getEnvStore(): CompanySessionEnvStore | null { return envStore; }
export function getQaPreviewConfig() { return qaPreviewConfig; }

/** Passes the module-level envStore into the pure helper. */
export function resolveSessionEnvs(sessionId: string, serviceId?: string): Record<string, string> {
  return resolveSessionEnvsFrom(envStore, sessionId, serviceId);
}

/** Passes the module-level envStore into the pure helper. */
export function importDotEnvIntoStore(
  hostWorkdirMount: string,
  sessionId: string,
): Promise<void> {
  return importDotEnvIntoStoreFrom(envStore, hostWorkdirMount, sessionId);
}
