/**
 * service_* tools (company B5) — structured log reads + container
 * lifecycle control for company agents.
 *
 * Registered next to sandboxTools (stable per-profile gate: company
 * sessions with a live sandbox binding — master included). Authorization
 * is enforced IN THE HANDLER, not by registration: the master always may;
 * a subordinate only controls its OWN service unless its role carries the
 * 'devops' skill (`decideServiceControl`, service-tools-core.ts).
 *
 * Reads come from the worker-wired supervisor stores (`stores.ts`, the
 * setQaTestRunStore pattern); lifecycle ops go through the per-thread
 * SandboxManager singleton — the same registry the SandboxService of this
 * worker provisioned into. Transitions are audited with actor
 * 'master'/'agent' so the timeline distinguishes agent-initiated flips
 * from supervisor/operator ones.
 */
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { getSandboxManager } from '@mcp/services/sandbox/index.js';
import type { RoleSkills } from '@mcp/company/types.js';
import { getServiceSupervisorStores } from '@mcp/company/services/service-supervisor/stores.js';
import {
  decideServiceControl,
  describeControlError,
  formatServiceLogPage,
  resolveSkillsSafe,
  type ServiceControlActor,
} from './service-tools-core.js';

const DEFAULT_LOG_LINES = 100;
const MAX_LOG_LINES = 500;
const LOG_STREAMS = new Set(['devserver', 'container', 'scaffold']);

interface LiveServiceLike { attached?: boolean; runtimePaused?: boolean; status: string }
interface ManagerLike {
  get(sessionId: string): LiveServiceLike | undefined;
  getService(sessionId: string, serviceId: string): LiveServiceLike | undefined;
  restartDevServer(sessionId: string): Promise<void>;
  restartService(sessionId: string, serviceId: string): Promise<void>;
  resumeSandbox(sessionId: string): Promise<unknown>;
  startServiceContainer(sessionId: string, serviceId: string): Promise<unknown>;
  pauseRuntimeContainer(sessionId: string, serviceId?: string | null): Promise<unknown>;
  unpauseRuntimeContainer(sessionId: string, serviceId?: string | null): Promise<unknown>;
}
const manager = (): ManagerLike => getSandboxManager() as unknown as ManagerLike;

function resolveActor(ctx: ToolContext): ServiceControlActor | null {
  const cc = ctx.companyContext;
  if (!cc) return null;
  const orch = cc.orchestrator as unknown as {
    getRoleDefaults?: (role: string) => { skills?: RoleSkills } | null;
  };
  return {
    isMaster: cc.isMaster,
    agentRole: cc.agentRole,
    boundServiceId: cc.sandbox?.serviceId ?? null,
    roleSkills: resolveSkillsSafe(orch.getRoleDefaults?.(cc.agentRole)?.skills),
  };
}

function recordAgentTransition(
  sessionId: number, serviceId: string, toState: string, reason: string, actor: string,
): void {
  try {
    getServiceSupervisorStores()?.transitions.record({
      sessionId, serviceId, kind: 'status', toState, reason, actor,
    });
  } catch { /* audit is best-effort */ }
}

type ControlOp = 'restart' | 'start' | 'stop';
const CONTROL_STATE: Record<ControlOp, string> = { restart: 'restarted', start: 'running', stop: 'paused' };

function controlTool(op: ControlOp, description: string): CoderTool {
  return {
    name: `service_${op}`,
    description,
    source: 'native',
    riskLevel: 'execute',
    mutates: true,
    parallelSafe: false,
    parameters: {
      type: 'object',
      properties: {
        service_id: {
          type: 'string',
          description: "Target service id as shown by list_services (the primary container is 'main').",
        },
      },
      required: ['service_id'],
      additionalProperties: false,
    },
    handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
      const cc = ctx.companyContext;
      const actor = resolveActor(ctx);
      if (!cc || !actor) return err(`service_${op} is only available in company sessions.`);
      const serviceId = String(args.service_id ?? '').trim();
      if (!serviceId) return err('service_id is required.');
      const decision = decideServiceControl(actor, serviceId);
      if (!decision.allowed) return err(decision.reason ?? 'Not allowed.');
      const key = String(cc.companySessionId);
      const m = manager();
      const live = serviceId === 'main' ? m.get(key) : m.getService(key, serviceId);
      if (live?.attached) {
        return err(describeControlError(serviceId, Object.assign(new Error('attached container'), { code: 'attached' })));
      }
      try {
        if (op === 'restart') {
          if (serviceId === 'main') await m.restartDevServer(key);
          else await m.restartService(key, serviceId);
        } else if (op === 'start') {
          if (live?.runtimePaused) await m.unpauseRuntimeContainer(key, serviceId);
          else if (serviceId === 'main') await m.resumeSandbox(key);
          else await m.startServiceContainer(key, serviceId);
        } else {
          await m.pauseRuntimeContainer(key, serviceId);
        }
      } catch (e) {
        return err(describeControlError(serviceId, e));
      }
      recordAgentTransition(
        cc.companySessionId, serviceId, CONTROL_STATE[op],
        `service_${op} tool (${actor.agentRole})`, decision.actor,
      );
      return ok(
        `Service '${serviceId}' ${op} executed. Verify with service_logs (structured history) or list_services (health verdict) before relying on it.`,
      );
    },
  };
}

/** `service_logs` — paged read of the persistent structured log ring buffer. */
const serviceLogs: CoderTool = {
  name: 'service_logs',
  // Auto-repeatable via the `_logs` suffix (tail-style naming convention).
  description:
    "Read the structured, timestamped log history of this session's services (persisted ring buffer fed by the supervisor — survives container restarts, unlike read_sandbox_logs). Every line is prefixed with its service_id and stream (devserver/container/scaffold). Omit service_id to read across ALL services; pass before_id from a previous page to go further back in time.",
  source: 'native',
  riskLevel: 'read',
  mutates: false,
  parallelSafe: true,
  parameters: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: "Filter to one service (e.g. 'main', 'api'). Omit for all services." },
      lines: { type: 'number', description: `Page size (default ${DEFAULT_LOG_LINES}, max ${MAX_LOG_LINES}).` },
      stream: { type: 'string', enum: ['devserver', 'container', 'scaffold'], description: 'Filter by stream.' },
      before_id: { type: 'number', description: 'Keyset cursor from a previous page footer — returns strictly older lines.' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const cc = ctx.companyContext;
    if (!cc) return err('service_logs is only available in company sessions.');
    const logs = getServiceSupervisorStores()?.logs;
    if (!logs) {
      return err('service log history is not available in this process (store not wired). Use read_sandbox_logs for a live tail.');
    }
    const requested = typeof args.lines === 'number' ? Math.floor(args.lines) : DEFAULT_LOG_LINES;
    const limit = Math.max(1, Math.min(MAX_LOG_LINES, requested));
    const stream = typeof args.stream === 'string' && LOG_STREAMS.has(args.stream) ? args.stream : undefined;
    const serviceId = typeof args.service_id === 'string' && args.service_id.trim() ? args.service_id.trim() : undefined;
    const beforeId = typeof args.before_id === 'number' && args.before_id > 0 ? Math.floor(args.before_id) : undefined;
    let rows;
    try {
      rows = logs.listPage(cc.companySessionId, {
        serviceId, beforeId, limit,
        stream: stream as 'devserver' | 'container' | 'scaffold' | undefined,
      });
    } catch (e) {
      return err(`service_logs failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (rows.length === 0) {
      return ok('(no structured service logs recorded yet — the supervisor collects them every ~15s from live containers. For an immediate raw tail, use read_sandbox_logs.)');
    }
    return ok(formatServiceLogPage(rows, limit));
  },
};

export const serviceTools: CoderTool[] = [
  serviceLogs,
  controlTool('restart', "Restart a service's dev-server process in place (files kept, process relaunched) — 'main' restarts the primary container's dev-server. Masters may target any service; subordinates only their own service unless their role has the 'devops' skill. Fails with a clear reason for attached (externally-managed) and Dockerfile-built containers."),
  controlTool('start', "Start (or unpause) a service container that is paused or stopped — 'main' resumes the primary. Same authorization as service_restart: master always; subordinates only their own service or with the 'devops' skill."),
  controlTool('stop', "Pause a running service container (process group frozen, files kept — resume with service_start). Same authorization as service_restart: master always; subordinates only their own service or with the 'devops' skill."),
];
