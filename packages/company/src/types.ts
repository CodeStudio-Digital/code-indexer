/**
 * Public types of the company package.
 *
 * Data models — and the SSE event taxonomy — are owned by
 * `@mcp/company-contracts` (a pure types package with zero runtime deps).
 * Runtime handles that reference concrete classes from other workspace
 * packages (orchestrator, sandbox driver, coder runner) stay here so the
 * contracts package can be consumed from anywhere without dragging in
 * server-side dependencies.
 */
import type { CoderRunner } from '@mcp/code-agent/core/runner.js';
import type { CoderRunBus } from '@apps/http-api/coder-bus.js';
import type { ChatUsage } from "@mcp/provider-sdk";
import type { FsCoderSession } from '@mcp/session-storage/fs-store/types.js';

// Re-export every data model + event for backwards compatibility.
// Existing imports `from '@mcp/company/types.js'` keep working unchanged.
export * from '@mcp/company-contracts';

// ─── Runtime handles ───────────────────────────────────────────

/**
 * Context injected into each agent's runCoder call to connect it to the
 * company orchestrator. Stored on ToolContext so tools can access it.
 */
export interface CompanyContext {
  orchestrator: import('@mcp/company/orchestrator.js').CompanyOrchestrator;
  companySessionId: string;
  /** Product capability hosted by the persistent Company lifecycle. */
  runtimeKind?: import('@mcp/company-contracts').CompanyRuntimeKind;
  /** Durable App Studio owner when runtimeKind === 'app_studio'. */
  appStudioSessionId?: string;
  /** Server-resolved, fail-closed runtime surface for this Company session. */
  capabilities?: import('@mcp/company-contracts').CompanySessionCapabilities;
  agentRole: string;
  agentRunId: string | null;
  allowedProjectIds: number[];
  isMaster: boolean;
  /**
   * Sandbox binding. When present, filesystem/shell tools are routed
   * into the container referenced here instead of touching the host
   * filesystem. Populated by `SandboxService` after a successful
   * provision (service-bound subordinates); absent otherwise.
   */
  sandbox?: SandboxBinding;
}

/**
 * What a `CompanyContext` carries for a container-bound agent. Consumed
 * by `runCoder` to swap the default local filesystem/shell ports for
 * sandbox adapters — transparent to every tool.
 */
export interface SandboxBinding {
  driver: import('@mcp/services/sandbox/ports/sandbox-driver.js').ISandboxDriver;
  /**
   * Current container id for the bound (session, serviceId?) pair.
   *
   * Implemented as a live getter by `SandboxService` so that reads
   * always reflect the latest id known to `SandboxManager`. When a
   * container is destroyed and recreated (retry, orphan recovery,
   * `forceRecreate`), long-lived agents keep their binding reference
   * and automatically pick up the new id on their next tool call —
   * no rehydrate event or binding invalidation required. Fallback is
   * the id captured at construction time, preserving behavior when the
   * manager hasn't rehydrated yet.
   */
  containerId: string;
  /** Absolute container-side workdir (e.g. `/app`). Used as cwd for tools. */
  workdir: string;
  /**
   * Absolute HOST path the container's `workdir` is bind-mounted from
   * (e.g. `D:\MCP\data\virtual-projects\<uuid>`). Present when the
   * sandbox was provisioned with `hostWorkdirMount` set — every
   * A `'node-only'` session has this. Tools that run in
   * the host process and need to touch the package filesystem
   * (`npm pack`, `readFile`, hash) translate container paths
   * (`/app/pkg`) to host paths via this field. Without it, host-side
   * `cwd: '/app/pkg'` becomes `\app\pkg` on Windows and ENOENTs.
   */
  hostWorkdirMount?: string;
  /** Public URL the dashboard iframes — kept here so tools/prompts can reference it. */
  previewUrl: string;
  /**
   * Stable per-session service identifier (e.g. 'main', 'frontend', 'api').
   * Present when the session runs multiple microservices; legacy single-
   * container sessions default to `'main'`. Used by tools and event
   * publishers to distinguish which container an action targeted.
   */
  serviceId?: string;
}

/** Runtime handle for a running subordinate agent. */
export interface SubordinateHandle {
  agentRunId: string;
  role: string;
  projectIds: number[];
  session: FsCoderSession;
  runner: CoderRunner;
  bus: CoderRunBus;
  done: Promise<{ reason: string; usage: ChatUsage; error?: string }>;
}
