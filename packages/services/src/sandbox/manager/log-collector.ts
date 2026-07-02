/**
 * ServiceLogCollector — incremental per-service log tail (company B4).
 *
 * Rides the ServiceSupervisor's 15s tick (no timer of its own — one
 * extra exec pair per live service per tick was judged cheaper and
 * simpler than a dedicated 3s poller; disable with MCP_SERVICE_LOGS='0'
 * at the supervisor). Two channels per the way each service actually
 * logs today:
 *
 *   - 'devserver'  — scaffolded/external-node services write
 *     `/tmp/dev-server.log` inside the container. We tail it by BYTE
 *     OFFSET: `wc -c` for the size, then `tail -c +N | head -c M` for
 *     exactly the new bytes (same exec transport `read_sandbox_logs`
 *     uses). Offsets live in memory; a shrunken file (restart/rotation)
 *     resets the cursor; first sight seeds a bounded tail.
 *
 *   - 'container'  — dockerfile-built and attached services log to the
 *     container's stdout/stderr. The real driver API
 *     (`getContainerLogs(id, tail)`) has NO `--since`, but it already
 *     passes `--timestamps`, so dedup is done by timestamp floor in
 *     `parseContainerLogs`.
 *
 * Every service is best-effort: one broken container must never abort
 * collection for its siblings. `collect` never throws.
 */
import {
  parseContainerLogs,
  planIncrementalRead,
  seedOffset,
  splitWithCarry,
  truncateLine,
  type CollectedLogLine,
  type CollectedStream,
} from './log-collector-core.js';

export type { CollectedLogLine, CollectedStream } from './log-collector-core.js';

const DEV_LOG_PATH = '/tmp/dev-server.log';
const MAX_CHUNK_BYTES = 32_768; // stays well under the driver's exec output cap
const SEED_BYTES = 8_192;
const CONTAINER_TAIL_LINES = 400;
const EXEC_TIMEOUT_MS = 5_000;

/** Structural driver slice — fakes in tests stay tiny. */
export interface LogCollectorDriver {
  exec(
    containerId: string,
    command: string,
    options: { cwd?: string; timeoutMs?: number },
  ): Promise<{ stdout: string; exitCode: number | null }>;
  getContainerLogs(containerId: string, tail?: number): Promise<string>;
}

export interface LogTarget {
  serviceId: string;
  containerId: string;
  channel: CollectedStream;
}

interface ServiceCursor {
  containerId: string;
  offset: number;
  carry: string;
  lastTs: number;
}

export class ServiceLogCollector {
  private readonly cursors = new Map<string, ServiceCursor>();

  /** Drops cursors of services that no longer exist (memory hygiene). */
  prune(liveServiceIds: Set<string>): void {
    for (const key of this.cursors.keys()) {
      if (!liveServiceIds.has(key)) this.cursors.delete(key);
    }
  }

  async collect(
    driver: LogCollectorDriver,
    targets: LogTarget[],
    nowMs: number = Date.now(),
  ): Promise<CollectedLogLine[]> {
    const out: CollectedLogLine[] = [];
    for (const target of targets) {
      if (!target.containerId) continue;
      try {
        const lines =
          target.channel === 'container'
            ? await this.collectContainer(driver, target, nowMs)
            : await this.collectDevserver(driver, target, nowMs);
        out.push(...lines);
      } catch {
        /* best-effort per service — never break the tick */
      }
    }
    return out;
  }

  private cursorFor(target: LogTarget): ServiceCursor {
    const existing = this.cursors.get(target.serviceId);
    if (existing && existing.containerId === target.containerId) return existing;
    // New service or the container was recreated — fresh cursor.
    const fresh: ServiceCursor = { containerId: target.containerId, offset: -1, carry: '', lastTs: 0 };
    this.cursors.set(target.serviceId, fresh);
    return fresh;
  }

  private async collectDevserver(
    driver: LogCollectorDriver,
    target: LogTarget,
    nowMs: number,
  ): Promise<CollectedLogLine[]> {
    const cursor = this.cursorFor(target);
    const sizeRes = await driver.exec(
      target.containerId,
      `wc -c < ${DEV_LOG_PATH} 2>/dev/null || echo 0`,
      { timeoutMs: EXEC_TIMEOUT_MS },
    );
    const size = Number.parseInt(sizeRes.stdout.trim(), 10);
    if (!Number.isFinite(size) || size <= 0) return [];
    if (cursor.offset < 0) cursor.offset = seedOffset(size, SEED_BYTES);
    const plan = planIncrementalRead(cursor.offset, size, MAX_CHUNK_BYTES);
    if (plan.reset) cursor.carry = '';
    if (plan.take <= 0) return [];
    const chunkRes = await driver.exec(
      target.containerId,
      `tail -c +${plan.start + 1} ${DEV_LOG_PATH} 2>/dev/null | head -c ${plan.take}`,
      { timeoutMs: EXEC_TIMEOUT_MS },
    );
    // Advance by the PLANNED byte count (tail/head are byte-exact); the JS
    // string length may diverge on multi-byte chars and must not be used.
    cursor.offset = plan.start + plan.take;
    const { lines, carry } = splitWithCarry(cursor.carry, chunkRes.stdout);
    cursor.carry = carry;
    return lines.map((line) => ({
      atMs: nowMs,
      serviceId: target.serviceId,
      stream: 'devserver' as const,
      line: truncateLine(line),
    }));
  }

  private async collectContainer(
    driver: LogCollectorDriver,
    target: LogTarget,
    nowMs: number,
  ): Promise<CollectedLogLine[]> {
    const cursor = this.cursorFor(target);
    const raw = await driver.getContainerLogs(target.containerId, CONTAINER_TAIL_LINES);
    if (!raw) return [];
    const { entries, lastTs } = parseContainerLogs(raw, cursor.lastTs, nowMs);
    cursor.lastTs = lastTs;
    return entries.map((e) => ({
      atMs: e.atMs,
      serviceId: target.serviceId,
      stream: 'container' as const,
      line: truncateLine(e.line),
    }));
  }
}
