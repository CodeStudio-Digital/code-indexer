import { clusterByEmbedding, clusterByTitle, planMerge } from './cluster.js';
import { selectArchivable } from './gc.js';
import {
  DEFAULT_CONSOLIDATOR_OPTIONS,
  type ConsolSnapshot,
  type ConsolidationPassResult,
  type ConsolidatorDeps,
  type ConsolidatorOptions,
} from './types.js';

/**
 * Periodic memory consolidator (one project per `runOnce`).
 *
 * Per category: cluster near-duplicates (embedding cosine, title fallback),
 * merge each cluster into a deterministic winner (content + importance bump +
 * file union + summed access), archive the losers. Then GC fully-stale, cold,
 * low-importance survivors. Best-effort: never throws; logs the outcome.
 */

const EMBED_HEAD_CHARS = 400;
const MERGE_PROJECT_ID_HINT = undefined; // writer.update only needs it for file moves

function groupByCategory(snaps: ConsolSnapshot[]): Map<string, ConsolSnapshot[]> {
  const groups = new Map<string, ConsolSnapshot[]>();
  for (const s of snaps) {
    const list = groups.get(s.category) ?? [];
    list.push(s);
    groups.set(s.category, list);
  }
  return groups;
}

export interface MemoryConsolidator {
  runOnce(projectId: number, projectName: string): Promise<ConsolidationPassResult>;
}

export function createMemoryConsolidator(deps: ConsolidatorDeps): MemoryConsolidator {
  const opts: ConsolidatorOptions = { ...DEFAULT_CONSOLIDATOR_OPTIONS, ...deps.options };
  const now = deps.now ?? (() => Date.now());

  async function clusterGroup(group: ConsolSnapshot[]): Promise<number[][]> {
    if (group.length < 2) return [];
    if (deps.embedder.hasBackend()) {
      try {
        const texts = group.map((s) => `${s.title}\n${s.content.slice(0, EMBED_HEAD_CHARS)}`);
        const vectors = await deps.embedder.embed(texts);
        const vmap = new Map<number, number[]>();
        group.forEach((s, i) => { if (vectors[i]?.length) vmap.set(s.id, vectors[i]); });
        return clusterByEmbedding(group, (id) => vmap.get(id), opts.mergeCosine);
      } catch {
        // Embedding failed → fall back to titles rather than skip the project.
      }
    }
    return clusterByTitle(group, opts.mergeTitleJaccard);
  }

  async function applyMerge(byId: Map<number, ConsolSnapshot>, ids: number[]): Promise<number[]> {
    const cluster = ids.map((id) => byId.get(id)!).filter(Boolean);
    if (cluster.length < 2) return [];
    const plan = planMerge(cluster);
    await deps.writer.update(plan.winnerId, {
      ...(plan.content !== null ? { content: plan.content } : {}),
      importance: plan.importance,
      projectId: MERGE_PROJECT_ID_HINT,
    });
    deps.store.unionFiles(plan.winnerId, plan.loserIds);
    deps.store.setAccessStats(plan.winnerId, plan.accessCount, plan.lastAccessedAt);
    for (const loserId of plan.loserIds) {
      await deps.writer.archive(loserId, `merged:${plan.winnerId}`);
    }
    return plan.loserIds;
  }

  async function runOnce(projectId: number, _projectName: string): Promise<ConsolidationPassResult> {
    const result: ConsolidationPassResult = {
      projectId, merged: 0, archived: 0, truncated: false, status: 'empty',
    };
    try {
      const all = deps.store.listLiveSnapshots(projectId);
      const truncated = all.length > opts.maxSnapshotsPerPass;
      const scanned = truncated
        ? [...all].sort((a, b) => a.id - b.id).slice(0, opts.maxSnapshotsPerPass)
        : all;
      result.truncated = truncated;
      if (scanned.length < 2) {
        deps.store.logDistill(projectId, { status: 'empty', merged: 0, archived: 0 });
        return result;
      }

      const byId = new Map(scanned.map((s) => [s.id, s]));
      const archivedThisPass = new Set<number>();

      // 1) Merge near-duplicates, capped per pass.
      for (const group of groupByCategory(scanned).values()) {
        if (result.merged >= opts.maxMergesPerPass) break;
        const clusters = await clusterGroup(group);
        for (const ids of clusters) {
          if (result.merged >= opts.maxMergesPerPass) break;
          const losers = await applyMerge(byId, ids.filter((id) => !archivedThisPass.has(id)));
          if (losers.length > 0) {
            losers.forEach((id) => archivedThisPass.add(id));
            result.merged++;
          }
        }
      }

      // 2) GC the survivors (exclude rows already archived as merge losers).
      const survivors = scanned.filter((s) => !archivedThisPass.has(s.id));
      const staleMap = deps.store.staleFilesBatch(survivors.map((s) => s.id), projectId);
      for (const target of selectArchivable(survivors, staleMap, opts, now())) {
        await deps.writer.archive(target.id, target.reason);
        result.archived++;
      }

      result.status = result.merged > 0 || result.archived > 0 ? 'ok' : 'empty';
      deps.store.logDistill(projectId, {
        status: result.status, merged: result.merged, archived: result.archived,
      });
      return result;
    } catch (err) {
      result.status = 'error';
      result.error = (err as Error).message ?? String(err);
      try { deps.store.logDistill(projectId, { status: 'error', merged: result.merged, archived: result.archived, error: result.error }); } catch { /* best-effort */ }
      return result;
    }
  }

  return { runOnce };
}
