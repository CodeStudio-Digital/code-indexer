/**
 * Spawn-time PROJECT MEMORY block for company subordinates (Mem C).
 *
 * Fetches task-relevant project memory through the company memory ports
 * and renders a bounded markdown section for the subordinate's system
 * prompt — so a fresh agent is born knowing the project's distilled
 * decisions, gotchas and conventions from previous runs (company AND
 * single-chat sessions: memory is scoped by project_id, not session).
 *
 * Lives in the SYSTEM prompt on purpose: like `operationalRules`, it
 * survives compaction; the complementary per-turn injection (runCoder's
 * `memoryRetriever`) handles mid-run task changes with tighter caps.
 *
 * Failure posture: best-effort everywhere. Disabled project, missing
 * ports, timeout or retrieval error → empty string (spawn proceeds with
 * no block). Memory must never delay or break a spawn beyond the 2s race.
 */
import { getCompanyMemoryPorts, type CompanyMemoryItem } from './ports.js';

export interface FetchProjectMemoryBlockOpts {
  projectId: number;
  projectName: string;
  /** Spawn task text (or resume message) — the relevance query. */
  taskText: string;
  /** Gate: migration 115 per-project memory toggle. */
  db: { getProjectMemoryEnabled(projectId: number): boolean };
  /** Retrieval budget before giving up. Default 2000ms (same as C4 hydrator). */
  timeoutMs?: number;
}

/** Per-item content budget — one memory should never dominate the block. */
const ITEM_CHAR_CAP = 1_200;
/** Whole-block budget (~3k tokens) — spawn prompts stay lean. */
const BLOCK_CHAR_CAP = 12_000;
const DEFAULT_TIMEOUT_MS = 2_000;

function recordRendered(ids: string[]): void {
  try { void Promise.resolve(getCompanyMemoryPorts()?.memoryRetriever.recordInjected?.(ids)).catch(() => undefined); }
  catch { /* best-effort telemetry */ }
}

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`memory retrieval timeout ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function renderItem(item: CompanyMemoryItem): string {
  const content = item.content.length > ITEM_CHAR_CAP
    ? `${item.content.slice(0, ITEM_CHAR_CAP)}…`
    : item.content;
  const stale = item.staleNote ? ` _[STALE: ${item.staleNote}]_` : '';
  return `- **${item.title}**${stale}\n${content}`;
}

/**
 * Returns the rendered `## PROJECT MEMORY` section, or `''` when there is
 * nothing to inject (memory off, no ports, no hits, or any failure).
 */
export async function fetchProjectMemoryBlock(opts: FetchProjectMemoryBlockOpts): Promise<string> {
  try {
    if (!opts.db.getProjectMemoryEnabled(opts.projectId)) return '';
    const ports = getCompanyMemoryPorts();
    if (!ports) return '';
    const task = opts.taskText.trim();
    if (!task) return '';

    const items = await raceWithTimeout(
      ports.memoryRetriever.retrieve(opts.projectId, opts.projectName, task),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (!items || items.length === 0) return '';

    const rendered: string[] = [];
    const includedIds: string[] = [];
    let used = 0;
    for (const item of items) {
      const block = renderItem(item);
      if (used + block.length > BLOCK_CHAR_CAP) break;
      rendered.push(block);
      includedIds.push(item.id);
      used += block.length;
    }
    if (rendered.length === 0) return '';

    recordRendered(includedIds);

    return `\n## PROJECT MEMORY (from previous runs)

Distilled knowledge other sessions recorded about this project — decisions, gotchas, conventions. Treat it as PRIOR knowledge: usually right, but verify against the current code before relying on it; items marked _[STALE]_ reference files that changed since they were recorded.

${rendered.join('\n')}\n`;
  } catch {
    return '';
  }
}

/**
 * Returns the rendered `## USER PREFERENCES` section (global user memory,
 * migration 145), or `''` when there's nothing. Targets the reserved user
 * project (id 0) and is NOT gated by any per-project toggle — these facts
 * apply to every project. Same best-effort posture as the project block.
 */
export async function fetchUserMemoryBlock(opts: { taskText: string; timeoutMs?: number }): Promise<string> {
  try {
    const ports = getCompanyMemoryPorts();
    if (!ports) return '';
    const task = opts.taskText.trim();
    if (!task) return '';

    const items = await raceWithTimeout(
      ports.memoryRetriever.retrieve(0, '__user__', task),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (!items || items.length === 0) return '';

    const rendered: string[] = [];
    const includedIds: string[] = [];
    let used = 0;
    for (const item of items) {
      const block = renderItem(item);
      if (used + block.length > BLOCK_CHAR_CAP) break;
      rendered.push(block);
      includedIds.push(item.id);
      used += block.length;
    }
    if (rendered.length === 0) return '';

    recordRendered(includedIds);

    return `\n## USER PREFERENCES (how I want you to work)

Global facts about the user and how they want you to work — these apply to EVERY project. Honor them unless they conflict with an explicit instruction in this task.

${rendered.join('\n')}\n`;
  } catch {
    return '';
  }
}
