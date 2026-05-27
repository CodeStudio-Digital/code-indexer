import type { ToolContext } from '@mcp/code-agent/core/tool.js';

/**
 * Best-effort mirror of the spec into the company shared drive at
 * `specs/<filename>`. Lets subordinates of the same company session
 * discover the spec via the existing `read_shared_file` tool without
 * needing repo filesystem access.
 *
 * - When `companyContext` is absent (chat-individual session), skips silently.
 * - When the drive write fails (storage full, permission, etc.), logs a
 *   warning and returns false — the repo-side write is the source of truth,
 *   so the spec submission is NOT failed.
 */
export async function mirrorSpecToCompanyDrive(
  ctx: ToolContext,
  fileName: string,
  body: string,
): Promise<{ mirrored: boolean; drivePath?: string; scopeKey?: string }> {
  const company = ctx.companyContext;
  if (!company) return { mirrored: false };
  try {
    const drive = company.orchestrator.driveStore;
    const scopeKey = drive.resolveScopeKey();
    const drivePath = `specs/${fileName}`;
    drive.write(scopeKey, drivePath, body, {
      role: company.agentRole,
      agentRunId: company.agentRunId ?? null,
    });
    return { mirrored: true, drivePath, scopeKey };
  } catch (e) {
    console.warn(
      `[coder] spec drive mirror failed: ${e instanceof Error ? e.message : String(e)} — repo write remains source of truth`,
    );
    return { mirrored: false };
  }
}
