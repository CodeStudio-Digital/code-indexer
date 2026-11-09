import type { CompactionSummaryV3 } from './summary-types.js';
import { clipMiddle, COMPACTION_SUMMARY_MAX_CHARS, COMPACTION_SUMMARY_MAX_TOKENS } from './summary-limits.js';

const CHAPTER_KEYS = [
  'title',
  'summary',
  'user_requests',
  'decisions',
  'work_completed',
  'files',
  'open_issues',
  'resolved_issues',
] as const;

const RESUME_KEYS = [
  'objective',
  'current_focus',
  'constraints',
  'pending_tasks',
  'next_step',
] as const;

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isFilesArray(value: unknown): value is Array<{ path: string; state: string }> {
  return Array.isArray(value) && value.every((item) => (
    isRecord(item)
    && exactKeys(item, ['path', 'state'])
    && typeof item.path === 'string'
    && typeof item.state === 'string'
  ));
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === '\\') {
        i++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function capString(value: string, cap: number): string {
  return clipMiddle(value.trim(), cap);
}

function capList(value: string[], count: number, chars: number): string[] {
  return value
    .map((item) => capString(item, chars))
    .filter(Boolean)
    .slice(0, count);
}

function summaryPayloadChars(summary: CompactionSummaryV3): number {
  return JSON.stringify({ version: 3, chapter: summary.chapter, resume: summary.resume }).length;
}

/** Apply list/string caps and the combined 1,500-token/8,000-character ceiling. */
export function capCompactionSummaryV3(summary: CompactionSummaryV3): CompactionSummaryV3 {
  const capped: CompactionSummaryV3 = {
    version: 3,
    chapter: {
      title: capString(summary.chapter.title, 120),
      summary: capString(summary.chapter.summary, 700),
      user_requests: capList(summary.chapter.user_requests, 4, 180),
      decisions: capList(summary.chapter.decisions, 4, 180),
      work_completed: capList(summary.chapter.work_completed, 4, 180),
      files: summary.chapter.files
        .map((file) => ({ path: capString(file.path, 160), state: capString(file.state, 180) }))
        .filter((file) => file.path)
        .slice(0, 6),
      open_issues: capList(summary.chapter.open_issues, 3, 180),
      resolved_issues: capList(summary.chapter.resolved_issues, 3, 180),
    },
    resume: {
      objective: capString(summary.resume.objective, 500),
      current_focus: capString(summary.resume.current_focus, 500),
      constraints: capList(summary.resume.constraints, 4, 180),
      pending_tasks: capList(summary.resume.pending_tasks, 6, 180),
      next_step: capString(summary.resume.next_step, 300),
    },
    ...(summary.metrics ? { metrics: summary.metrics } : {}),
  };

  // A conservative four-chars/token estimate enforces both documented caps.
  const payloadCap = Math.min(
    COMPACTION_SUMMARY_MAX_CHARS,
    COMPACTION_SUMMARY_MAX_TOKENS * 4,
  );
  const removable: Array<unknown[]> = [
    capped.chapter.resolved_issues,
    capped.chapter.files,
    capped.chapter.work_completed,
    capped.chapter.user_requests,
    capped.chapter.decisions,
    capped.chapter.open_issues,
    capped.resume.constraints,
    capped.resume.pending_tasks,
  ];
  while (summaryPayloadChars(capped) > payloadCap) {
    const list = removable.find((candidate) => candidate.length > 1);
    if (list) {
      list.pop();
      continue;
    }
    const scalars: Array<[object, string]> = [
      [capped.chapter, 'summary'],
      [capped.resume, 'current_focus'],
      [capped.resume, 'objective'],
      [capped.resume, 'next_step'],
    ];
    let shrunk = false;
    for (const [owner, key] of scalars) {
      const record = owner as Record<string, unknown>;
      const value = String(record[key] ?? '');
      if (value.length > 80) {
        record[key] = clipMiddle(value, Math.max(80, Math.floor(value.length * 0.8)));
        shrunk = true;
        break;
      }
    }
    if (!shrunk) break;
  }
  return capped;
}

function hasMinimumContent(summary: CompactionSummaryV3): boolean {
  const { chapter, resume } = summary;
  return chapter.summary.length >= 8
    || resume.objective.length >= 8
    || resume.current_focus.length >= 8
    || resume.next_step.length >= 8
    || chapter.user_requests.length > 0
    || chapter.decisions.length > 0
    || chapter.work_completed.length > 0
    || chapter.files.length > 0
    || chapter.open_issues.length > 0
    || chapter.resolved_issues.length > 0
    || resume.constraints.length > 0
    || resume.pending_tasks.length > 0;
}

/** Strict parser: missing, mistyped, or unexpected model fields are rejected. */
export function parseCompactionSummaryV3(text: string): CompactionSummaryV3 | null {
  const json = extractFirstJsonObject(text);
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (!isRecord(value) || !exactKeys(value, ['version', 'chapter', 'resume'])) return null;
    if (value.version !== 3 || !isRecord(value.chapter) || !isRecord(value.resume)) return null;
    if (!exactKeys(value.chapter, CHAPTER_KEYS) || !exactKeys(value.resume, RESUME_KEYS)) return null;
    const chapter = value.chapter;
    const resume = value.resume;
    if (
      typeof chapter.title !== 'string'
      || typeof chapter.summary !== 'string'
      || !isStringArray(chapter.user_requests)
      || !isStringArray(chapter.decisions)
      || !isStringArray(chapter.work_completed)
      || !isFilesArray(chapter.files)
      || !isStringArray(chapter.open_issues)
      || !isStringArray(chapter.resolved_issues)
      || typeof resume.objective !== 'string'
      || typeof resume.current_focus !== 'string'
      || !isStringArray(resume.constraints)
      || !isStringArray(resume.pending_tasks)
      || typeof resume.next_step !== 'string'
    ) return null;

    const parsed = capCompactionSummaryV3({
      version: 3,
      chapter: {
        title: chapter.title,
        summary: chapter.summary,
        user_requests: chapter.user_requests,
        decisions: chapter.decisions,
        work_completed: chapter.work_completed,
        files: chapter.files,
        open_issues: chapter.open_issues,
        resolved_issues: chapter.resolved_issues,
      },
      resume: {
        objective: resume.objective,
        current_focus: resume.current_focus,
        constraints: resume.constraints,
        pending_tasks: resume.pending_tasks,
        next_step: resume.next_step,
      },
    });
    return hasMinimumContent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isCompactionSummaryV3(value: unknown): value is CompactionSummaryV3 {
  if (!isRecord(value) || value.version !== 3 || !isRecord(value.chapter) || !isRecord(value.resume)) {
    return false;
  }
  return typeof value.chapter.title === 'string' && typeof value.resume.objective === 'string';
}
