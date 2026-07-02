export interface ProjectIndexIgnoreSource {
  index_ignore_patterns?: string | string[] | null;
}

const MAX_PATTERNS = 500;

function cleanPattern(input: string): string | null {
  let pattern = input.trim().replace(/\\/g, '/');
  if (!pattern || pattern.startsWith('#')) return null;
  pattern = pattern.replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  if (!pattern || pattern === '.') return null;
  return pattern;
}

export function normalizeIndexIgnorePattern(input: string): string | null {
  return cleanPattern(input);
}

export function normalizeIndexIgnoreFolderPattern(input: string): string | null {
  const pattern = cleanPattern(input);
  if (!pattern) return null;
  if (pattern.endsWith('/') || /[*?[\]{}!]/.test(pattern)) return pattern;
  return `${pattern}/`;
}

export function normalizeIndexIgnorePatterns(patterns: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of patterns) {
    const pattern = normalizeIndexIgnorePattern(raw);
    if (!pattern || seen.has(pattern)) continue;
    seen.add(pattern);
    out.push(pattern);
    if (out.length >= MAX_PATTERNS) break;
  }
  return out;
}

export function parseIndexIgnorePatterns(value: unknown): string[] {
  if (Array.isArray(value)) {
    return normalizeIndexIgnorePatterns(value.filter((v): v is string => typeof v === 'string'));
  }
  if (typeof value !== 'string') return [];
  const text = value.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return normalizeIndexIgnorePatterns(parsed.filter((v): v is string => typeof v === 'string'));
    }
  } catch {
    // Plain text fallback below.
  }
  return normalizeIndexIgnorePatterns(text.split(/\r?\n|,/g));
}

export function serializeIndexIgnorePatterns(patterns: readonly string[]): string {
  return JSON.stringify(normalizeIndexIgnorePatterns(patterns));
}

export function projectIndexIgnorePatterns(project: ProjectIndexIgnoreSource | null | undefined): string[] {
  return parseIndexIgnorePatterns(project?.index_ignore_patterns ?? null);
}

export function mergeIndexIgnorePatterns(
  ...sources: ReadonlyArray<readonly string[] | string | string[] | null | undefined>
): string[] {
  const merged: string[] = [];
  for (const source of sources) merged.push(...parseIndexIgnorePatterns(source));
  return normalizeIndexIgnorePatterns(merged);
}

export function globPrunesForIndexIgnore(patterns: readonly string[]): string[] {
  const prunes: string[] = [];
  for (const pattern of normalizeIndexIgnorePatterns(patterns)) {
    if (!pattern.endsWith('/') || pattern.startsWith('!')) continue;
    const dir = pattern.slice(0, -1);
    if (!dir || /[*?[\]{}]/.test(dir)) continue;
    prunes.push(`${dir}/**`, `**/${dir}/**`);
  }
  return prunes;
}
