import type { CompanySandboxStore } from '@mcp/store/company-sandbox-store.js';
import type { CompanySandboxServicesStore } from '@mcp/store/company-sandbox-services-store.js';
import type { CompanySessionEnvStore } from '@mcp/store/company-session-env-store.js';

export interface QaPreviewConfig {
  httpApiPort: number;
  hasQaPlaywrightSkill: (sessionId: string) => boolean;
}

/**
 * Holds the optional persistence stores wired at server boot. The
 * SandboxManager constructs lazily (`getSandboxManager()`) but the
 * stores come from `createDeps()` LATER, so each accessor returns
 * `null` until wired. Tests / CLI / non-HTTP paths legitimately run
 * with everything null.
 */
export class SandboxStoreContainer {
  private sandboxStore: CompanySandboxStore | null = null;
  private servicesStore: CompanySandboxServicesStore | null = null;
  private envStore: CompanySessionEnvStore | null = null;
  private qaPreviewConfig: QaPreviewConfig | null = null;

  setSandboxStore(store: CompanySandboxStore | null): void {
    this.sandboxStore = store;
  }
  getSandboxStore(): CompanySandboxStore | null {
    return this.sandboxStore;
  }

  setServicesStore(store: CompanySandboxServicesStore | null): void {
    this.servicesStore = store;
  }
  getServicesStore(): CompanySandboxServicesStore | null {
    return this.servicesStore;
  }

  setEnvStore(store: CompanySessionEnvStore | null): void {
    this.envStore = store;
  }
  getEnvStore(): CompanySessionEnvStore | null {
    return this.envStore;
  }

  setQaPreviewConfig(cfg: QaPreviewConfig | null): void {
    this.qaPreviewConfig = cfg;
  }
  getQaPreviewConfig(): QaPreviewConfig | null {
    return this.qaPreviewConfig;
  }
}

/**
 * Process-wide singleton. Setters on `sandbox-manager.ts` delegate here
 * so the public API (`setCompanySandboxStore`, etc.) is preserved while
 * collaborators read from the container instead of module globals.
 */
export const sandboxStores = new SandboxStoreContainer();
