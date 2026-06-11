/**
 * DsToolBinding — resolve a qual DesignSystemSession uma chamada de tool
 * pertence, sem acoplar as tools ao runtime que as hospeda.
 *
 * Dois hosts:
 *   - **company** (legacy): a sessão DS é a vinculada ao company session
 *     do orquestrador (`getSessionByCompanySessionId`). Mantido apenas
 *     enquanto sessões legacy existirem.
 *   - **studio**: sessão single de chat sobre um projeto-workspace; a
 *     sessão DS é a vinculada ao projeto (`getSessionByProjectId`).
 *
 * O `profile` também dirige o comportamento do audit pré-publish
 * (perfil studio não exige Storybook/bin — ver package-audit.ts).
 */
import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';
import type { DesignSystemSession, DesignSystemStore } from '@mcp/store/design-system-store.js';

export type DsToolProfile = 'company' | 'studio';

export interface DsToolBinding {
  /** Audit/publish behavioural profile. */
  profile: DsToolProfile;
  /** Resolve the DS session for this tool call (null = none bound). */
  resolveDsSession(store: DesignSystemStore): DesignSystemSession | null;
  /** Short label for error messages, e.g. `company_session_id=12`. */
  describeBinding(): string;
}

export function companyBinding(orchestrator: CompanyOrchestrator): DsToolBinding {
  return {
    profile: 'company',
    resolveDsSession: (store) =>
      store.getSessionByCompanySessionId(orchestrator.effectiveSessionId),
    describeBinding: () => `company_session_id=${orchestrator.effectiveSessionId}`,
  };
}

export function studioBinding(projectId: number): DsToolBinding {
  return {
    profile: 'studio',
    resolveDsSession: (store) => store.getSessionByProjectId(projectId),
    describeBinding: () => `project_id=${projectId}`,
  };
}
