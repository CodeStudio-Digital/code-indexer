/**
 * Seeds stack-specific snapshots into the project(s) linked to a builder
 * session. Snapshots are written to the MCP DB via `snapshotService` and
 * retrieved at agent runtime through the `query_snapshots` MCP tool —
 * this is the canal we use to inform the LLM about idiomatic patterns
 * for its selected stack (React 19 / Vue 3.5 / Angular 19+).
 *
 * Idempotency: each stack+version combination is tagged
 * `stack:<stack>@v<SEED_VERSION>`. Re-running the seeder for a project
 * that already has a snapshot with that tag is a no-op. Bumping
 * SEED_VERSION in `stack-seeds.ts` causes the next run to create a fresh
 * set alongside the old ones (we don't auto-delete — human/ops review).
 */

import type { SnapshotService } from '../../../services/snapshots.js';
import type { BuilderStack } from '../../../sandbox/types.js';
import { STACK_SEEDS, stackVersionTag } from './stack-seeds.js';

export class StackSnapshotSeeder {
  constructor(private readonly snapshotService: SnapshotService) {}

  /**
   * Seed all provided projects with the stack's snapshots. Safe to call
   * with zero projects (no-op). Safe to call twice (idempotent per
   * project+stack+version).
   */
  seedForSession(projectIds: number[], stack: BuilderStack): void {
    if (projectIds.length === 0) return;
    const docs = STACK_SEEDS[stack];
    if (!docs || docs.length === 0) return;
    const versionTag = stackVersionTag(stack);

    for (const pid of projectIds) {
      if (this.hasVersion(pid, versionTag)) continue;
      for (const d of docs) {
        try {
          this.snapshotService.create(pid, {
            title: d.title,
            category: d.category,
            content: d.content,
            tags: ['seeded', 'builder-mode', versionTag, ...(d.extraTags ?? [])],
            createdBy: 'builder-mode-seeder',
          });
        } catch (err) {
          // A single bad snapshot (e.g. title collides with an earlier
          // manual entry) shouldn't abort the whole seeding pass.
          console.error(
            `[stack-snapshot-seeder] failed to seed "${d.title}" into project ${pid}:`,
            (err as Error).message,
          );
        }
      }
    }
  }

  private hasVersion(projectId: number, versionTag: string): boolean {
    const existing = this.snapshotService.list(projectId);
    for (const s of existing) {
      try {
        const tags = JSON.parse(s.tags ?? '[]') as unknown;
        if (Array.isArray(tags) && tags.includes(versionTag)) return true;
      } catch {
        /* ignore malformed tags */
      }
    }
    return false;
  }
}
