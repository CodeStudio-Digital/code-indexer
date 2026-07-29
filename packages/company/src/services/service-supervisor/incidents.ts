/**
 * ServiceSupervisor incident sink (company B3) — where a service goes when
 * auto-restart gave up (3 attempts / 10min, still down).
 *
 * Fan-out, every channel best-effort and independent:
 *   - `master.notify` — the SAME channel RuntimeReconciler uses for its
 *     nudges, so it survives a dead master (notify resurrects it).
 *   - board post ('system', kind 'blocker').
 *   - `sandbox.service.incident` on the session metaBus (dashboard feed).
 *   - kanban card WITH dedupe — a `[incident:<serviceId>]` title marker is
 *     the dedupe key because `KanbanTag` has no 'incident' value; an open
 *     (non-done) marked card gets a comment instead of a duplicate card.
 *   - InboxQueue → the first role whose skills include 'devops', if any.
 *
 * `buildIncidentMessage` is PURE; `emitIncident` performs the I/O.
 */
import { resolveRoleSkills, type RoleSkills } from '@mcp/company/types.js';

export interface ServiceIncident {
  sessionId: string;
  serviceId: string;
  detail?: string;
  restartAttempts: number;
  atMs: number;
}

/** B8 — `local:<sessionId>` marks a host process (LocalProcessManager). */
export function isLocalServiceId(serviceId: string): boolean {
  return serviceId.startsWith('local:');
}

/** PURE — markdown incident summary shared by every channel. */
export function buildIncidentMessage(i: ServiceIncident): string {
  // B8 — host processes have no container to rebuild and no auto-restart
  // (v1), so the remediation text must not point at container tooling.
  if (isLocalServiceId(i.serviceId)) {
    const lines = [
      `Local project **${i.serviceId}** (host process, no container) is DOWN. ` +
        'Auto-restart is not available for host processes.',
    ];
    if (i.detail) lines.push(`Last evidence: ${i.detail}`);
    lines.push(
      'Manual action needed: restart the local project from the Services panel ' +
        'or ask the user to restart it on the host.',
    );
    return lines.join('\n');
  }
  const lines = [
    `Service **${i.serviceId}** is DOWN and automatic recovery has been exhausted ` +
      `(${i.restartAttempts} restart attempt${i.restartAttempts === 1 ? '' : 's'} in the last window).`,
  ];
  if (i.detail) lines.push(`Last evidence: ${i.detail}`);
  lines.push(
    'Manual action needed: check the service logs (`GET /services/' +
      i.serviceId +
      '/logs`), then Retry/rebuild the container or fix the app crash.',
  );
  return lines.join('\n');
}

/** Dedupe marker prepended to incident card titles. */
export function incidentCardTitle(serviceId: string): string {
  return `[incident:${serviceId}]`;
}

/**
 * PURE — first role in `config_json.role_assignments` whose resolved skills
 * include `skillId`. Tolerates every malformed shape (same posture as
 * `hasQaPlaywrightSkill`). Handles both the legacy `string[]` and the v2
 * `RoleSkillsConfig` forms via `resolveRoleSkills`.
 */
export function findRoleWithSkill(configJson: string | null, skillId: string): string | null {
  if (!configJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const roles = (parsed as { role_assignments?: unknown }).role_assignments;
  if (!Array.isArray(roles)) return null;
  for (const role of roles) {
    if (!role || typeof role !== 'object') continue;
    const name = (role as { role?: unknown }).role;
    if (typeof name !== 'string' || !name) continue;
    try {
      const skills = resolveRoleSkills((role as { skills?: RoleSkills }).skills, {});
      if (skills.includes(skillId)) return name;
    } catch {
      continue;
    }
  }
  return null;
}

// ─── I/O side ─────────────────────────────────────────────────────

export interface IncidentDeps {
  notifyMaster(message: string): void;
  board: { post(authorRole: string, agentRunId: string | null, kind: 'blocker', content: string): void };
  publisher: { publish(event: string, data: unknown): void };
  kanban?: {
    listCardsFull(): Array<{ id: string; column: string; title: string }>;
    createCard(input: {
      title: string;
      description?: string;
      column?: 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';
      tag?: 'bug' | 'feature' | 'refactor' | 'documentation' | null;
      created_by?: string;
    }): { id: string };
    addComment(cardId: string, authorRole: string, agentRunId: string | null, content: string): unknown;
  };
  inbox?: {
    /** Matches `InboxQueue.send` (sync or async — the result is not consumed). */
    send(args: {
      fromAgentRunId: string;
      fromRole: string;
      toRole: string;
      kind: 'notify';
      body: string;
      wait: boolean;
      priority?: 'low' | 'normal' | 'urgent';
    }): unknown;
  };
  /** Session `config_json` reader — used for the devops-skill routing. */
  getSessionConfigJson?: () => string | null;
}

export async function emitIncident(deps: IncidentDeps, incident: ServiceIncident): Promise<void> {
  const msg = buildIncidentMessage(incident);

  try {
    // The `[SERVICE INCIDENT]` marker is what the master's system prompt
    // keys its reaction protocol on (B8) — keep prefix and prompt in sync.
    deps.notifyMaster(`[SYSTEM] [SERVICE INCIDENT] ${msg}`);
  } catch { /* best-effort */ }

  try {
    deps.board.post('system', null, 'blocker', msg);
  } catch { /* best-effort */ }

  try {
    deps.publisher.publish('sandbox.service.incident', {
      sandboxId: String(incident.sessionId),
      serviceId: incident.serviceId,
      detail: incident.detail ?? null,
      restartAttempts: incident.restartAttempts,
      at: incident.atMs,
    });
  } catch { /* best-effort */ }

  try {
    upsertIncidentCard(deps, incident, msg);
  } catch { /* best-effort */ }

  try {
    await routeToDevops(deps, incident, msg);
  } catch { /* best-effort */ }
}

function upsertIncidentCard(deps: IncidentDeps, incident: ServiceIncident, msg: string): void {
  const kanban = deps.kanban;
  if (!kanban) return;
  const marker = incidentCardTitle(incident.serviceId);
  const open = kanban.listCardsFull().find((c) => c.column !== 'done' && c.title.startsWith(marker));
  if (open) {
    kanban.addComment(open.id, 'supervisor', null, `[AUTO] Incident re-fired.\n\n${msg}`);
    return;
  }
  kanban.createCard({
    title: `${marker} service down — auto-restart exhausted`,
    description: msg,
    column: 'todo',
    tag: 'bug',
    created_by: 'supervisor',
  });
}

async function routeToDevops(
  deps: IncidentDeps,
  incident: ServiceIncident,
  msg: string,
): Promise<void> {
  if (!deps.inbox || !deps.getSessionConfigJson) return;
  const role = findRoleWithSkill(deps.getSessionConfigJson(), 'devops');
  if (!role) return;
  await Promise.resolve(deps.inbox.send({
    fromAgentRunId: incident.sessionId,
    fromRole: 'supervisor',
    toRole: role,
    kind: 'notify',
    body: `[SERVICE INCIDENT] ${msg}`,
    wait: false,
    priority: 'urgent',
  }));
}
