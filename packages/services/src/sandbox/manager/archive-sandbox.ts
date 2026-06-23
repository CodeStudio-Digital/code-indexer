/**
 * Export a sandbox's workdir as a tar archive. Used by:
 *   - `SandboxService` (orchestrator) when a session is paused gracefully.
 *   - `SandboxManager.pauseSandbox` immediately before stopping the
 *     container so the workdir survives a reaper-driven kill.
 *
 * Bind-mount sandboxes are excluded by `pauseSandbox` — the host filesystem
 * already persists everything. This module just does the driver call.
 */
import type { Sandbox } from '@mcp/services/sandbox/types.js';
import type { ISandboxDriver } from '@mcp/services/sandbox/ports/sandbox-driver.js';

/**
 * Tar-export the workdir. Returns `null` when:
 *   - The sandbox is unknown.
 *   - The container has no id (never started).
 *   - The status isn't `ready`/`error` (mid-provision = no stable fs).
 *   - The driver throws (container gone, runtime hiccup). Warn-and-go.
 *
 * Never throws — `null` is the universal "couldn't archive" signal.
 */
export async function archiveSandboxWorkdir(
  sb: Sandbox | undefined,
  driver: ISandboxDriver | null,
): Promise<Buffer | null> {
  if (!sb || !sb.containerId || !driver) return null;
  if (sb.status !== 'ready' && sb.status !== 'error') return null;
  try {
    return await driver.exportWorkdir(sb.containerId, sb.workdir);
  } catch (e) {
    console.warn(
      `[sandbox-manager] archive ${sb.id} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}
