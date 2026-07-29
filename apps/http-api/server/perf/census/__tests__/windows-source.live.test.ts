/**
 * Live test for the Windows collector — it really spawns PowerShell and reads
 * the machine's process table, so it is opt-in:
 *
 *   $env:MCP_CENSUS_SMOKE=1; npx vitest run apps/http-api/server/perf/census
 *
 * It covers the two things no unit test can: that the generated script runs at
 * all under a real PowerShell (quoting, `-EncodedCommand`, execution policy),
 * and that stopping the source leaves no orphaned `powershell.exe` behind.
 */
import { describe, it, expect } from 'vitest';
import { buildDescendantTree } from '@mcp/shared/utils/process-census/tree.js';
import { deriveRates } from '@mcp/shared/utils/process-census/cpu-derive.js';
import { WindowsCensusSource } from '../windows-source.js';

const ENABLED = process.env.MCP_CENSUS_SMOKE === '1' && process.platform === 'win32';

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return check();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!ENABLED)('WindowsCensusSource (live)', () => {
  it('collects real frames, derives rates and dies without orphans', { timeout: 60_000 }, async () => {
    const source = new WindowsCensusSource();
    source.start(1_000);
    expect(source.status()).toBe('warming');

    expect(await waitFor(() => source.latest() !== null, 20_000)).toBe(true);
    const first = source.latest()!;
    expect(source.status()).toBe('live');
    // A real Windows box runs far more than this; the point is "not empty".
    expect(first.rows.length).toBeGreaterThan(30);
    expect(first.rows.some((row) => row.pid === process.pid)).toBe(true);
    // The first frame sweeps every command line in one query.
    expect(first.commandLines.size).toBeGreaterThan(10);

    // The collector is our own child, so it must show up in our subtree.
    const tree = buildDescendantTree(first.rows, process.pid);
    const collector = tree.ordered.find((node) => /powershell/i.test(node.row.exe));
    expect(collector, 'collector should appear as a descendant').toBeDefined();
    const collectorPid = collector!.row.pid;

    expect(await waitFor(() => source.previous() !== null, 20_000)).toBe(true);
    const rates = deriveRates(source.previous(), source.latest()!, 8);
    const own = rates.get(process.pid);
    expect(own).toBeDefined();
    expect(own!.cpuPercent).not.toBeNull();
    expect(own!.cpuPercent!).toBeGreaterThanOrEqual(0);

    source.stop();
    expect(source.status()).toBe('stopped');
    expect(source.latest()).toBeNull();
    expect(await waitFor(() => !alive(collectorPid), 10_000)).toBe(true);
  });
});
