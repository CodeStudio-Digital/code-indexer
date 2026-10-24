/**
 * Sandbox-introspection tools — available to master AND subordinates
 * whenever a session has a live builder sandbox. Give agents eyes on
 * the dev-server so they can verify their own changes produced what
 * they expected (routes mounted, Vite compile errors, HMR reloads).
 *
 * Without these, agents would write code, call it "done", and only the
 * human would notice a runtime error in the iframe console. Reading the
 * dev-server log closes the feedback loop without requiring the agent
 * to leave its sandbox.
 */

import type { CoderTool, ToolContext } from "@mcp/code-agent/core/tool.js";
import type { ToolResult } from "@mcp/agent-runtime-host/tool-result.js";
import { ok, err } from "@mcp/agent-runtime-host/tool-result.js";
import { getServiceSupervisorStores } from '@mcp/company/services/service-supervisor/stores.js';

const DEFAULT_LINES = 200;
const MAX_LINES = 2_000;

/**
 * Supervisor-health projection for `list_services` (B5). Worker-only in
 * practice: the stores setter is called by company-worker.ts; on main (or
 * in tests without the binding) this returns an empty map and the listing
 * silently omits health columns — same tolerant posture as the supervisor.
 */
function readHealthByService(sessionId: string | undefined): Map<
  string,
  { health: string; restartCount: number; lastHealthAtMs: number | null }
> {
  const out = new Map<string, { health: string; restartCount: number; lastHealthAtMs: number | null }>();
  if (typeof sessionId !== 'string') return out;
  try {
    const rows = getServiceSupervisorStores()?.services?.listBySessionAll(sessionId) ?? [];
    for (const r of rows) {
      out.set(r.service_id, {
        health: r.health ?? 'unknown',
        restartCount: r.restart_count ?? 0,
        lastHealthAtMs: r.last_health_at_ms ?? null,
      });
    }
  } catch { /* advisory only */ }
  return out;
}

/**
 * `read_sandbox_logs` — tail the Vite dev-server log file produced by
 * the scaffolder (`/tmp/dev-server.log` inside the container). Same
 * data the dashboard's "Terminal" button shows, but callable from
 * inside the agent loop.
 *
 * Use cases the agent discovers by reading the description:
 *   - After editing a component, verify HMR succeeded (look for
 *     `hmr update /src/App.tsx`) vs failed to reload (`error ...`).
 *   - After adding a route, check the page reload landed.
 *   - After installing a dep, check `npm install` actually completed
 *     without build errors.
 */
const readSandboxLogs: CoderTool = {
  name: 'read_sandbox_logs',
  // Auto-repeatable via `_logs` suffix.
  description:
    'Tail the dev-server log from the session\'s builder sandbox (e.g. Vite output from `npm run dev`). Returns the last N lines of stdout+stderr, useful for verifying that a code change compiled, that HMR fired, or that an `npm install` succeeded. Only works in sessions that were created with builder mode. Use this AFTER write_file/edit_file calls to confirm your change had the intended effect before declaring success. For persistent, timestamped, paginated per-service history (including sibling services), use `service_logs` instead.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      lines: {
        type: 'number',
        description: `How many trailing lines to return (default ${DEFAULT_LINES}, max ${MAX_LINES}). Pick a small value (50-100) for a quick check after a single edit; pick larger values (500+) when diagnosing a compile error that spans multiple events.`,
      },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const binding = ctx.companyContext?.sandbox;
    if (!binding) {
      return err(
        'read_sandbox_logs is only available in builder-mode sessions. ' +
          'The company session for this agent has no sandbox attached.',
      );
    }
    const requested = typeof args.lines === 'number' ? args.lines : DEFAULT_LINES;
    const lines = Math.max(10, Math.min(MAX_LINES, Math.floor(requested)));

    // `tail -n <N> <file> 2>/dev/null || true` is robust against the
    // log file not existing yet (dev-server still starting up) and
    // against tail's stderr chatter (e.g. on alpine's busybox).
    const res = await binding.driver.exec(
      binding.containerId,
      `tail -n ${lines} /tmp/dev-server.log 2>/dev/null || true`,
      { cwd: binding.workdir, timeoutMs: 5_000 },
    );
    if (res.exitCode !== 0 && !res.stdout) {
      return err(
        `read_sandbox_logs failed (exit ${res.exitCode}): ${res.stderr.trim() || '(no output)'}`,
      );
    }
    const output = res.stdout.trim();
    if (!output) {
      return ok(
        '(dev-server log is empty — the server may still be starting up, ' +
          'or your container was just created. Wait a few seconds and retry.)',
      );
    }
    return ok(
      `Dev-server log (last ${lines} lines from /tmp/dev-server.log):\n\n${output}`,
    );
  },
};

/**
 * `list_services` — read-only snapshot of every container alive in this
 * session. Mirrors the `peers:` block in the builder prompt but is
 * callable on demand, so an agent whose session started before another
 * service was provisioned can discover the new peer without waiting
 * for the master to update its prompt.
 *
 * Returns one line per container with its serviceId, stack,
 * internalUrl (docker-network URL siblings use), and previewUrl.
 * The caller's own container is marked `[you]`. No health probes —
 * the master's `list_containers` tool is the place for that.
 */
const listServices: CoderTool = {
  name: 'list_services',
  // Auto-repeatable via `list_*` prefix.
  description:
    'List every container (primary + microservices) running in this session. Returns their service_id, stack, internal docker-network URL (for container-to-container calls), and public preview URL. Use this when your code needs to reach a sibling service but you\'re unsure of its hostname, or to confirm a newly-added microservice actually came up. Only available in builder-mode sessions. Each line also carries the supervisor\'s health verdict (healthy/degraded/down/unknown) and restart count when available.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  handler: async (_args, ctx: ToolContext): Promise<ToolResult> => {
    const binding = ctx.companyContext?.sandbox;
    if (!binding) {
      return err(
        'list_services is only available in builder-mode sessions. ' +
          'The company session for this agent has no sandbox attached.',
      );
    }
    const orchestrator = ctx.companyContext?.orchestrator as unknown as {
      listSandboxPeers?: (
        selfServiceId?: string | null,
      ) => Array<{
        serviceId: string;
        stack: string;
        internalUrl: string;
        previewUrl: string;
        isSelf: boolean;
      }>;
    } | undefined;
    const peers = orchestrator?.listSandboxPeers?.(binding.serviceId ?? 'main') ?? [];
    if (peers.length === 0) {
      return ok('(no containers registered for this session yet)');
    }
    const healthByService = readHealthByService(ctx.companyContext?.companySessionId);
    const lines = peers.map((p) => {
      const self = p.isSelf ? ' [you]' : '';
      const h = healthByService.get(p.serviceId);
      const health = h
        ? `  health=${h.health}${h.restartCount > 0 ? ` restarts=${h.restartCount}` : ''}${
            h.lastHealthAtMs ? ` last_check=${new Date(h.lastHealthAtMs).toISOString()}` : ''
          }`
        : '';
      return `  - ${p.serviceId.padEnd(12)} ${p.stack.padEnd(12)} internal=${p.internalUrl}  preview=${p.previewUrl || '(none)'}${health}${self}`;
    });
    return ok(
      `Services in this session:\n${lines.join('\n')}\n\n` +
        'For container-to-container fetches, use `internal` (e.g. inside this container: `fetch("${peers[0]?.internalUrl}/...")`). The same URLs are available as SERVICE_URL_<ID> env vars.',
    );
  },
};

export const sandboxTools: CoderTool[] = [readSandboxLogs, listServices];
