/**
 * Task-preflight output parsing — split from preflight-prompt.ts for LOC
 * discipline. Defensive by construction: every field fails independently,
 * unknown tool/skill names and memory titles are dropped, and an empty
 * validated seed is reported as a parse failure (the session then runs
 * exactly as today).
 */
import type { PreflightSeed } from './preflight-prompt.js';

const TASK_KINDS = new Set(['bugfix', 'feature', 'refactor', 'explore', 'docs', 'config', 'test', 'other']);
const PROFILES = new Set(['bootstrap', 'navigate', 'full']);
const MAX_REASON_CHARS = 120;

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('empty response');
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(fenced);
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('response was not JSON');
  }
}

export interface PreflightParseContext {
  toolNames: ReadonlySet<string>;
  memoryTitles: readonly string[];
  skillIds: ReadonlySet<string>;
  maxTools: number;
  maxMemories: number;
  maxSkills: number;
}

/**
 * Validate + clamp the analyzer output. Returns null when nothing usable
 * survives (caller reports `parse_fail` and the session runs unseeded).
 */
export function parsePreflightOutput(raw: string, ctx: PreflightParseContext): PreflightSeed | null {
  let parsed: Record<string, unknown>;
  try {
    const value = extractJson(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }

  const seed: PreflightSeed = {};

  if (typeof parsed.profile === 'string' && PROFILES.has(parsed.profile)) {
    seed.profile = parsed.profile as PreflightSeed['profile'];
  }
  if (typeof parsed.task_kind === 'string' && TASK_KINDS.has(parsed.task_kind)) {
    seed.taskKind = parsed.task_kind;
  }

  if (Array.isArray(parsed.tools)) {
    const pins: string[] = [];
    for (const item of parsed.tools) {
      const name = typeof item === 'string' ? item : (item as { name?: unknown } | null)?.name;
      if (typeof name !== 'string') continue;
      const trimmed = name.trim();
      if (!ctx.toolNames.has(trimmed) || pins.includes(trimmed)) continue;
      pins.push(trimmed);
      if (pins.length >= ctx.maxTools) break;
    }
    if (pins.length > 0) seed.pinTools = pins;
  }

  if (Array.isArray(parsed.skills)) {
    const suggested: Array<{ id: string; reason: string }> = [];
    for (const item of parsed.skills) {
      const id = typeof item === 'string' ? item : (item as { id?: unknown } | null)?.id;
      if (typeof id !== 'string') continue;
      const trimmed = id.trim();
      if (!ctx.skillIds.has(trimmed) || suggested.some((s) => s.id === trimmed)) continue;
      const whyRaw = typeof item === 'string' ? '' : (item as { why?: unknown }).why;
      const reason = typeof whyRaw === 'string' ? whyRaw.trim().slice(0, MAX_REASON_CHARS) : '';
      suggested.push({ id: trimmed, reason });
      if (suggested.length >= ctx.maxSkills) break;
    }
    if (suggested.length > 0) seed.suggestedSkills = suggested;
  }

  if (Array.isArray(parsed.memories)) {
    const byLowerTitle = new Map(ctx.memoryTitles.map((t) => [t.toLowerCase(), t]));
    const memories: Array<{ title: string; reason: string }> = [];
    for (const item of parsed.memories) {
      if (!item || typeof item !== 'object') continue;
      const row = item as { title?: unknown; why?: unknown };
      if (typeof row.title !== 'string') continue;
      const canonical = byLowerTitle.get(row.title.trim().toLowerCase());
      if (!canonical || memories.some((m) => m.title === canonical)) continue;
      const reason = typeof row.why === 'string' ? row.why.trim().slice(0, MAX_REASON_CHARS) : '';
      memories.push({ title: canonical, reason });
      if (memories.length >= ctx.maxMemories) break;
    }
    if (memories.length > 0) seed.memories = memories;
  }

  const usable = seed.profile !== undefined
    || (seed.pinTools?.length ?? 0) > 0
    || (seed.suggestedSkills?.length ?? 0) > 0
    || (seed.memories?.length ?? 0) > 0;
  return usable ? seed : null;
}
