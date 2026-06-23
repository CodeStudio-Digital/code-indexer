/**
 * Shared binary probe — "is <bin> installed and answering?" plus a best-effort
 * version string. Extracted from driver-factory's `canInvoke` so BOTH sandbox
 * driver selection AND the first-run preflight checks use one source of truth
 * for liveness (rather than duplicating the `version --format` idiom).
 */
import type { IShellPort } from '@mcp/code-agent/ports/shell-port.js';

export interface BinaryProbe {
  present: boolean;
  /** First dotted version token found in the CLI output, or null. */
  version: string | null;
}

/**
 * Run `<binary> <versionArgs>` and decide whether the binary is live.
 *
 * Defaults to the docker/podman idiom `version --format {{.Client.Version}}`.
 * Liveness = exit 0, OR (for older CLIs that ignore `--format`) any output that
 * mentions a version. Never throws — a missing binary returns {present:false}.
 */
export async function probeBinaryVersion(
  shell: IShellPort,
  binary: string,
  versionArgs: string[] = ['version', '--format', '{{.Client.Version}}'],
): Promise<BinaryProbe> {
  try {
    const r = await shell.run(binary, versionArgs, {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });
    const out = `${r.stdout}${r.stderr}`;
    const present = r.exitCode === 0 || /version/i.test(out);
    return { present, version: present ? extractVersion(out) : null };
  } catch {
    return { present: false, version: null };
  }
}

/** Pull the first dotted version token out of CLI output (best-effort). */
function extractVersion(output: string): string | null {
  const m = output.match(/\d+\.\d+(?:\.\d+)?/);
  return m ? m[0] : null;
}
