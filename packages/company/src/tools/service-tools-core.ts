/**
 * PURE decision/formatting core of the service_* tools (company B5).
 * No manager, no stores, no ToolContext — everything here is testable
 * with plain objects. `service-tools.ts` owns the I/O.
 */
import { resolveRoleSkills, type RoleSkills } from '@mcp/company/types.js';

/** Who is asking to control a service, reduced to the facts that matter. */
export interface ServiceControlActor {
  isMaster: boolean;
  agentRole: string;
  /** serviceId of the caller's own bound container (null when unbound). */
  boundServiceId: string | null;
  /** Resolved skill ids of the caller's role ([] when unknown). */
  roleSkills: readonly string[];
}

export interface ControlDecision {
  allowed: boolean;
  /** Human-readable refusal (already actionable) when `allowed` is false. */
  reason?: string;
  /** Transition-audit actor tag: 'master' | 'agent'. */
  actor: 'master' | 'agent';
}

/**
 * Gate for service_restart/start/stop: the master always may; a
 * subordinate only for its OWN container, unless its role carries the
 * 'devops' skill (the same skill incidents.ts routes incidents to).
 */
export function decideServiceControl(
  actor: ServiceControlActor,
  serviceId: string,
): ControlDecision {
  const actorTag = actor.isMaster ? 'master' : 'agent';
  if (actor.isMaster) return { allowed: true, actor: actorTag };
  if (actor.boundServiceId && actor.boundServiceId === serviceId) {
    return { allowed: true, actor: actorTag };
  }
  if (actor.roleSkills.includes('devops')) return { allowed: true, actor: actorTag };
  return {
    allowed: false,
    actor: actorTag,
    reason:
      `Role '${actor.agentRole}' may only control its own service` +
      `${actor.boundServiceId ? ` ('${actor.boundServiceId}')` : ''}, not '${serviceId}'. ` +
      "Ask the master to run this, or have a role with the 'devops' skill handle it.",
  };
}

/** Never-throwing wrapper over resolveRoleSkills (malformed configs → []). */
export function resolveSkillsSafe(skills: RoleSkills | undefined): string[] {
  try {
    return resolveRoleSkills(skills, {});
  } catch {
    return [];
  }
}

/**
 * Maps manager refusals to agent-readable text. `ServiceRestartError`
 * (and shape-alikes) carry a `code`; everything else falls back to the
 * plain message.
 */
export function describeControlError(serviceId: string, e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: unknown })?.code;
  switch (code) {
    case 'not_running':
      return `Service '${serviceId}' has no running container (${message}). Use service_start first, or ask the operator to Retry it from the dashboard.`;
    case 'runtime_paused':
      return `Service '${serviceId}' is runtime-paused (${message}). Call service_start to unpause it before restarting.`;
    case 'attached':
      return `Service '${serviceId}' is an externally-managed container — the platform never starts/stops it. Manage it from the host (podman/docker) instead.`;
    case 'project_dockerfile':
      return `Service '${serviceId}' runs a Dockerfile-built image (${message}). Its process cannot be relaunched in place — ask the operator to Retry/rebuild it from the dashboard.`;
    default:
      return `Service '${serviceId}': ${message}`;
  }
}

export interface FormattableLogRow {
  id: string;
  seq: number;
  serviceId: string;
  stream: string;
  line: string;
  atMs: number;
}

/**
 * Formats a newest-first store page as ascending, service-prefixed text —
 * every line carries its service_id so multi-service reads stay legible.
 * Appends the keyset cursor when the page is full.
 */
export function formatServiceLogPage(rowsNewestFirst: FormattableLogRow[], limit: number): string {
  const ascending = rowsNewestFirst.slice().reverse();
  const body = ascending
    .map((r) => `[${r.serviceId}/${r.stream}] ${new Date(r.atMs).toISOString()} ${r.line}`)
    .join('\n');
  const minSeq = rowsNewestFirst.reduce(
    (minimum, row) => Math.min(minimum, row.seq),
    Number.POSITIVE_INFINITY,
  );
  const footer =
    rowsNewestFirst.length >= limit && Number.isFinite(minSeq)
      ? `\n\n(older lines exist — pass before_seq=${minSeq} to page back)`
      : '';
  return `${body}${footer}`;
}
