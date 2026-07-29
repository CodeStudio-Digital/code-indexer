/**
 * DsToolBinding — resolve a qual DesignSystemSession uma chamada de tool
 * pertence, sem acoplar as tools ao runtime que as hospeda.
 *
 * Host único: **studio** — sessão single de chat sobre um projeto-workspace;
 * a sessão DS é a vinculada ao projeto (`getSessionByProjectId`). (O host
 * company foi aposentado junto com o pipeline DS de company, mig 132.)
 *
 * O `profile` dirige o comportamento do audit pré-publish (perfil studio
 * não exige Storybook/bin — ver package-audit.ts). O valor `company`
 * permanece no tipo porque é o perfil estrito/default do
 * `auditDesignSystemPackage` em pacotes legados.
 */
import type { DesignSystemSession, DesignSystemStore } from '@mcp/store/design-system-store.js';

export type DsToolProfile = 'company' | 'studio';

export interface DsToolBinding {
  /** Audit/publish behavioural profile. */
  profile: DsToolProfile;
  /** Resolve the DS session for this tool call (null = none bound). */
  resolveDsSession(store: DesignSystemStore): Promise<DesignSystemSession | null>;
  /** Short label for error messages, e.g. `project_id=12`. */
  describeBinding(): string;
}

export function studioBinding(projectId: number): DsToolBinding {
  return {
    profile: 'studio',
    resolveDsSession: (store) => store.getSessionByProjectId(projectId),
    describeBinding: () => `project_id=${projectId}`,
  };
}
