import type { CompanyRoleConfig } from '@mcp/company/types.js';
import type { ServerDeps } from '../../deps.js';

/** Session configuration takes precedence over the template it was created from. */
export function sessionRoles(
  deps: ServerDeps,
  session: { config_json: string; template_id: number | null },
): CompanyRoleConfig[] {
  const configured: CompanyRoleConfig[] = JSON.parse(session.config_json || '{}').role_assignments ?? [];
  if (configured.length || session.template_id == null) return configured;
  return deps.companyStore.getTemplate(session.template_id)?.roles ?? [];
}
