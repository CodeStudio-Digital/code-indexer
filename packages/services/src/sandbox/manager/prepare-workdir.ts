/**
 * Three-step workdir prep run inside a fresh container before the
 * scaffolder starts. Forgiving by design — third-party base images
 * don't always build with the right ownership/caps, so we make the
 * "happy path" robust and surface a clear error only when the user's
 * code actually can't write.
 *
 *   1. `mkdir -p <workdir>` as root.
 *   2. Best-effort `chown -R <isolationUser> <workdir>` — swallows EPERM
 *      when CAP_CHOWN is dropped. Stock image bakes chown at build time
 *      to make this a no-op.
 *   3. Write probe AS the isolation user. Catches the edge case where
 *      caps were dropped AND the image wasn't pre-chowned. Throws with
 *      the exact remediation steps when it fails.
 *
 * Extracted from `SandboxManager.prepareWorkdir` so the contract is
 * documented in one place and the three steps can be exercised with a
 * fake driver alone.
 */
import type { ISandboxDriver } from '@mcp/services/sandbox/ports/sandbox-driver.js';
import { shQuote } from '@mcp/services/sandbox/manager/util/shell.js';

export async function prepareWorkdir(
  driver: ISandboxDriver,
  containerId: string,
  workdir: string,
  isolationUser: string,
): Promise<void> {
  // Step 1: mkdir (always). Run as root for maximum portability.
  const mkdirRes = await driver.exec(containerId, `mkdir -p ${shQuote(workdir)}`, {
    cwd: undefined,
    timeoutMs: 10_000,
    user: '0:0',
  });
  if (mkdirRes.exitCode !== 0) {
    throw new Error(
      `Failed to create workdir ${workdir} (exit ${mkdirRes.exitCode}): ${mkdirRes.stderr.trim() || mkdirRes.stdout.trim()}`,
    );
  }

  // Step 2: best-effort chown. `|| true` absorbs EPERM when CAP_CHOWN
  // was dropped. The stock Dockerfile bakes the chown in at build
  // time — doing it here is a convenience for third-party images that
  // didn't.
  if (isolationUser && isolationUser !== '0:0') {
    await driver.exec(
      containerId,
      `chown -R ${shQuote(isolationUser)} ${shQuote(workdir)} 2>/dev/null || true`,
      { cwd: undefined, timeoutMs: 10_000, user: '0:0' },
    );
  }

  // Step 3: write probe as the actual isolation user. Catches the edge
  // case where caps are dropped AND the image wasn't built with the
  // correct ownership — surface the issue clearly before the scaffolder
  // starts.
  const probeCmd = `touch ${shQuote(`${workdir}/.mcp-write-probe`)} && rm ${shQuote(`${workdir}/.mcp-write-probe`)}`;
  const probeRes = await driver.exec(containerId, probeCmd, {
    cwd: undefined,
    timeoutMs: 10_000,
    // Numeric uid[:gid] passes straight through; names work too if
    // the container resolves them. Empty string → container default.
    user: isolationUser || null,
  });
  if (probeRes.exitCode !== 0) {
    throw new Error(
      `Workdir ${workdir} is not writable by user '${isolationUser || 'default'}'. ` +
        `Rebuild the sandbox image so /app is chowned at build time, ` +
        `or set MCP_SANDBOX_USER='' to run as root. ` +
        `stderr: ${probeRes.stderr.trim() || probeRes.stdout.trim()}`,
    );
  }
}
