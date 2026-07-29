/**
 * Find and remove every container created by a previous incarnation of
 * this process that no active session still owns. Runs once on boot,
 * AFTER `reconcileFromDb` has had a chance to reclaim alive containers
 * into the in-memory registry.
 *
 * Identification is by label (`mcp.sandbox=1`), not by name — that way
 * a future rename of the naming scheme still catches old containers
 * on upgrade.
 *
 * Implementation note: we shell out through the driver's underlying CLI
 * rather than `ISandboxDriver.destroy` because we don't have container
 * IDs at this point — we need to ask the runtime for them first. We
 * also don't add a method to `ISandboxDriver` because the operation is
 * CLI-specific; E2B manages its own lifecycle.
 *
 * Two-phase per orphan:
 *   1. SALVAGE (fail-closed): `exportWorkdir` → `saveArchive`. Skipped
 *      when the session already has a bind-mounted host workdir or the
 *      container is missing the `mcp.workdir` label.
 *   2. DESTROY after salvage: `cli rm -f <id>`. A primary container whose
 *      archive cannot be committed is left intact for a later recovery pass.
 *
 * Belt-and-suspenders: also clears any stale in-memory entry or DB row
 * that points at the destroyed container so the next provision falls
 * through cleanly to archive-restore.
 */
import { saveArchive } from '@mcp/services/sandbox/archive.js';
import type { Sandbox } from '@mcp/services/sandbox/types.js';
import type { ISandboxDriver } from '@mcp/services/sandbox/ports/sandbox-driver.js';
import type { SandboxRegistry } from '@mcp/services/sandbox/manager/state/registry.js';
import type { CompanySandboxStore } from '@mcp/store/company-sandbox-store.js';
import type { CompanySandboxServicesStore } from '@mcp/store/company-sandbox-services-store.js';
import {
  hasInitializedWorkdir,
} from '@mcp/services/sandbox/manager/util/paths.js';
import { resolveHostWorkdirMount } from '@mcp/services/sandbox/manager/io/env-helpers.js';

/** Narrow surface the orphan reaper needs from the driver's CLI handle. */
interface ReaperCliHandle {
  binary?: string;
  shell?: {
    run: (
      program: string,
      args: string[],
      options: { cwd: string; encoding: string },
    ) => Promise<{ stdout: string; exitCode: number | null }>;
  };
  globalArgs?: string[];
}

interface OrphanRow {
  id: string;
  sessionId: string;
  workdir: string;
}

export interface ReapOrphansDeps {
  driver: ISandboxDriver;
  registry: SandboxRegistry;
  store: CompanySandboxStore | null;
  servicesStore: CompanySandboxServicesStore | null;
  /** Container ids reclaimed by `reconcileFromDb` — must not be reaped. */
  keepAlive?: ReadonlySet<string>;
}

export async function reapOrphans(deps: ReapOrphansDeps): Promise<void> {
  const cli = deps.driver as unknown as ReaperCliHandle;
  if (!cli.binary || !cli.shell) return;

  // Ask the runtime for id + session + workdir in a single round-trip.
  // Tab-delimited so empty label values are unambiguous.
  const list = await cli.shell.run(
    cli.binary,
    [
      ...(cli.globalArgs ?? []),
      'ps', '-a',
      '--filter', 'label=mcp.sandbox=1',
      '--format', '{{.ID}}\t{{.Label "mcp.sessionId"}}\t{{.Label "mcp.workdir"}}',
    ],
    { cwd: process.cwd(), encoding: 'utf-8' },
  );
  if (list.exitCode !== 0) return;

  const allLabeled: OrphanRow[] = list.stdout
    .split('\n')
    .map((line) => line.split('\t').map((s) => s.trim()))
    .filter((cols) => cols[0])
    .map((cols) => ({ id: cols[0], sessionId: cols[1] ?? '', workdir: cols[2] ?? '' }));
  if (allLabeled.length === 0) return;

  const keepAlive: ReadonlySet<string> = deps.keepAlive ?? new Set();
  const dbContainerIds = new Set<string>();
  if (deps.store) {
    for (const row of deps.store.listActive()) {
      if (row.container_id) dbContainerIds.add(row.container_id);
    }
  }
  if (deps.servicesStore) {
    for (const row of deps.servicesStore.listActive()) {
      if (row.container_id) dbContainerIds.add(row.container_id);
    }
  }

  const orphans = allLabeled.filter((o) => {
    if (keepAlive.has(o.id) || dbContainerIds.has(o.id)) return false;
    // Skip containers whose mcp.sessionId is not a Company UUID (optionally
    // followed by a service id). Chrome Service and Verdaccio use named ids, so
    // they must be left alone even though they carry mcp.sandbox=1.
    const sessionPart = o.sessionId.split(':')[0] ?? '';
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        sessionPart,
      )
    ) return false;
    return true;
  });
  const skipped = allLabeled.length - orphans.length;
  if (skipped > 0) {
    console.log(
      `[sandbox-manager] orphan reaper: skipping ${skipped} container(s) still owned by an active session`,
    );
  }
  if (orphans.length === 0) return;

  // Serial (not parallel) to keep podman-cp I/O sane on disk-backed
  // hosts. Each export is ~10-30s with node_modules; a handful of
  // orphans running in parallel would saturate I/O and lose tars
  // halfway. We accept the serial latency — it happens once per
  // server boot, on the cold path.
  let salvaged = 0;
  let destroyed = 0;
  for (const orphan of orphans) {
    const sessionId = orphan.sessionId.split(':')[0] ?? '';
    const isPrimary = orphan.sessionId === sessionId;
    // Skip salvage entirely when this session has a bind-mounted host
    // workdir — the files are already safe on disk, and `docker cp`
    // from a dying container just burns I/O. Secondary-service containers
    // also skip salvage: the single canonical workdir archive belongs to
    // the primary sandbox and must never be overwritten by a service tar.
    const orphanHostMount = sessionId
      ? resolveHostWorkdirMount(sessionId)
      : null;
    const alreadyPersisted =
      !!orphanHostMount && hasInitializedWorkdir(orphanHostMount);

    if (sessionId && isPrimary && orphan.workdir && !alreadyPersisted) {
      try {
        const tar = await deps.driver.exportWorkdir(orphan.id, orphan.workdir);
        if (!tar || tar.byteLength === 0) {
          throw new Error('sandbox driver returned an empty workdir archive');
        }
        await saveArchive(sessionId, tar);
        salvaged++;
        console.log(
          `[sandbox-manager] salvaged archive for session=${sessionId} ` +
            `from orphan container ${orphan.id.slice(0, 12)} (${tar.byteLength} bytes)`,
        );
      } catch (e) {
        console.warn(
          `[sandbox-manager] salvage failed closed for session=${sessionId}; ` +
            `container ${orphan.id.slice(0, 12)} was left intact: ${
              e instanceof Error ? e.message : String(e)
            }`,
        );
        continue;
      }
    }

    await cli.shell
      .run(cli.binary, [...(cli.globalArgs ?? []), 'rm', '-f', orphan.id], {
        cwd: process.cwd(),
        encoding: 'utf-8',
      })
      .then(() => {
        destroyed++;
      })
      .catch(() => void 0);

    // Belt-and-suspenders cleanup of any stale registry/DB pointers.
    if (orphan.sessionId) {
      // Cast — the registry's `primary` map is named `sandboxes` on the
      // class, but exposed as `primary` on `SandboxRegistry` directly.
      const reg = deps.registry as { primary: Map<string, Sandbox> };
      reg.primary.delete(orphan.sessionId);
      if (deps.store && sessionId) {
        try {
          deps.store.delete(sessionId);
        } catch (e) {
          console.warn(
            `[sandbox-manager] clearing stale sandbox record ${orphan.sessionId} failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }
  }
  console.log(
    `[sandbox-manager] reaped ${destroyed}/${orphans.length} orphaned sandbox container(s), ` +
      `salvaged ${salvaged} archive(s)`,
  );
}
