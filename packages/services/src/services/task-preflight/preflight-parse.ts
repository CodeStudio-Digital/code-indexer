/**
 * Task-preflight output parsing — split from preflight-prompt.ts for LOC
 * discipline. Defensive by construction: every field fails independently,
 * unknown skill ids and memory titles are dropped, a legacy `tools` field is
 * ignored, and an empty validated seed is reported as a parse failure (the
 * session then runs exactly as today).
 */
import type {
  PreflightMemoryEntry,
  PreflightSeed,
  PreflightSkillEvidence,
} from './preflight-types.js';

const TASK_KINDS = new Set(['bugfix', 'feature', 'refactor', 'explore', 'docs', 'config', 'test', 'other']);
const PROFILES = new Set(['bootstrap', 'navigate', 'full']);
const MAX_REASON_CHARS = 120;
const AUTOMATIC_SESSION_TITLES = new Set([
  'nova sessao',
  'nova sessao global',
  'new session',
  'new global session',
]);

function titleKey(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

export function isAutomaticSessionTitle(title: string | null | undefined): boolean {
  return !title?.trim() || AUTOMATIC_SESSION_TITLES.has(titleKey(title));
}

export function cleanSessionTitleSeed(text: string): string {
  return text
    .replace(/<file_refs>[\s\S]*?<\/file_refs>/gi, '')
    .replace(/<active_skills>[\s\S]*?<\/active_skills>/gi, '')
    .replace(/<active-context>[\s\S]*?<\/active-context>/gi, '')
    .replace(/<ide_context>[\s\S]*?<\/ide_context>/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

export function cleanSessionTitle(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let text = raw.trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { session_title?: unknown; title?: unknown };
    const nested = parsed?.session_title ?? parsed?.title;
    if (typeof nested === 'string') text = nested;
  } catch { /* plain-text title */ }
  const title = text
    .replace(/^```(?:text)?\s*|\s*```$/gi, '')
    .split(/\r?\n/, 1)[0]!
    .replace(/^(?:session\s+title|title|titulo|título)\s*:\s*/i, '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?;:]+$/g, '')
    .trim()
    .slice(0, 80)
    .trim();
  return title || undefined;
}

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
  memoryTitles: readonly string[];
  memoryEntries?: readonly PreflightMemoryEntry[];
  skillIds: ReadonlySet<string>;
  skillMetaById?: ReadonlyMap<string, {
    evidence?: PreflightSkillEvidence;
    projectSlugs?: readonly string[];
  }>;
  projectSlugs?: ReadonlySet<string>;
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

  const sessionTitle = cleanSessionTitle(parsed.session_title);
  if (sessionTitle) seed.sessionTitle = sessionTitle;

  if (typeof parsed.profile === 'string' && PROFILES.has(parsed.profile)) {
    seed.profile = parsed.profile as PreflightSeed['profile'];
  }
  if (typeof parsed.task_kind === 'string') {
    const taskKind = parsed.task_kind.trim().toLowerCase();
    if (TASK_KINDS.has(taskKind)) seed.taskKind = taskKind;
  }

  if (Array.isArray(parsed.projects) && ctx.projectSlugs && ctx.projectSlugs.size > 0) {
    const projects: Array<{ slug: string; reason: string }> = [];
    for (const item of parsed.projects) {
      const slug = typeof item === 'string' ? item : (item as { slug?: unknown } | null)?.slug;
      if (typeof slug !== 'string') continue;
      const trimmed = slug.trim();
      if (!ctx.projectSlugs.has(trimmed) || projects.some((p) => p.slug === trimmed)) continue;
      const whyRaw = typeof item === 'string' ? '' : (item as { why?: unknown }).why;
      const reason = typeof whyRaw === 'string' ? whyRaw.trim().slice(0, MAX_REASON_CHARS) : '';
      projects.push({ slug: trimmed, reason });
    }
    if (projects.length > 0) seed.targetProjects = projects;
  }

  if (Array.isArray(parsed.skills)) {
    const suggested: NonNullable<PreflightSeed['suggestedSkills']> = [];
    const targetSlugs = new Set(seed.targetProjects?.map((p) => p.slug) ?? []);
    for (const item of parsed.skills) {
      const id = typeof item === 'string' ? item : (item as { id?: unknown } | null)?.id;
      if (typeof id !== 'string') continue;
      const trimmed = id.trim();
      if (!ctx.skillIds.has(trimmed) || suggested.some((s) => s.id === trimmed)) continue;
      const meta = ctx.skillMetaById?.get(trimmed);
      if (ctx.skillMetaById && !meta?.evidence) continue;
      if (
        meta?.evidence === 'project_scope' &&
        meta?.projectSlugs && meta.projectSlugs.length > 0 &&
        (targetSlugs.size === 0 || !meta.projectSlugs.some((slug) => targetSlugs.has(slug)))
      ) continue;
      const whyRaw = typeof item === 'string' ? '' : (item as { why?: unknown }).why;
      const reason = typeof whyRaw === 'string' ? whyRaw.trim().slice(0, MAX_REASON_CHARS) : '';
      suggested.push({ id: trimmed, reason, ...(meta?.evidence ? { evidence: meta.evidence } : {}) });
      if (suggested.length >= ctx.maxSkills) break;
    }
    if (suggested.length > 0) seed.suggestedSkills = suggested;
  }

  if (Array.isArray(parsed.memories)) {
    const entries: readonly PreflightMemoryEntry[] =
      ctx.memoryEntries ?? ctx.memoryTitles.map((title): PreflightMemoryEntry => ({ title }));
    const memories: Array<{ title: string; reason: string; projectSlug?: string }> = [];
    for (const item of parsed.memories) {
      if (!item || typeof item !== 'object') continue;
      const row = item as { title?: unknown; project?: unknown; why?: unknown };
      if (typeof row.title !== 'string') continue;
      const wantedTitle = row.title.trim().toLowerCase();
      const wantedProject = typeof row.project === 'string' ? row.project.trim() : '';
      const candidates = entries.filter((entry) =>
        entry.title.toLowerCase() === wantedTitle &&
        (!wantedProject || entry.projectSlug === wantedProject),
      );
      if (candidates.length !== 1) continue;
      const canonical = candidates[0]!;
      if (memories.some((m) => m.title === canonical.title && m.projectSlug === canonical.projectSlug)) continue;
      const reason = typeof row.why === 'string' ? row.why.trim().slice(0, MAX_REASON_CHARS) : '';
      memories.push({
        title: canonical.title,
        reason,
        ...(canonical.projectSlug ? { projectSlug: canonical.projectSlug } : {}),
      });
      if (memories.length >= ctx.maxMemories) break;
    }
    if (memories.length > 0) seed.memories = memories;
  }

  const usable = seed.sessionTitle !== undefined
    || seed.profile !== undefined
    || seed.taskKind !== undefined
    || (seed.targetProjects?.length ?? 0) > 0
    || (seed.suggestedSkills?.length ?? 0) > 0
    || (seed.memories?.length ?? 0) > 0;
  return usable ? seed : null;
}
