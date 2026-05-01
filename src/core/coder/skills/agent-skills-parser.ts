/**
 * Parser for the Agent Skills standard used by Claude Code, Codex,
 * OpenCode, Cursor, etc.
 *
 * Input:
 *   - SKILL.md     → contextual skill (frontmatter: name, description, references)
 *   - commands/*.md → user-invocable slash command (frontmatter: description,
 *                     argument-hint, allowed-tools)
 *
 * We parse a minimal YAML subset inline — the frontmatter in these files
 * is always shallow (strings, string arrays, or simple scalars). Adding a
 * yaml dependency would be overkill.
 */
import type { UpsertSkillInput } from '../../../store/skill-store.js';

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  references?: string[];
  'allowed-tools'?: string[];
  'argument-hint'?: string;
  [key: string]: unknown;
}

export interface ParsedSkillFile {
  kind: 'skill' | 'command';
  frontmatter: SkillFrontmatter;
  body: string;
  /** Relative path within the repo (used to locate references folder). */
  path: string;
}

// ─── Minimal YAML frontmatter parser ─────────────────────────────

/**
 * Parse a small subset of YAML sufficient for SKILL frontmatter:
 *   key: scalar
 *   key: [a, b, c]
 *   key:
 *     - a
 *     - b
 *   key: "quoted string"
 *   key:                       (object — one level of nesting)
 *     subkey: scalar
 *     subkey: [a, b]
 *     subkey:
 *       - a
 *       - b
 *
 * Nested object support is shallow on purpose — the only consumer that
 * needs it is the v2 `trigger:` field (`trigger.paths` / `trigger.roles` /
 * `trigger.tags`). Adding a real YAML library for two more keys is not
 * worth it.
 */
export function parseFrontmatterYaml(src: string): SkillFrontmatter {
  const out: SkillFrontmatter = {};
  const lines = src.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    const rest = m[2];

    if (rest === '') {
      // Block list?
      let j = i + 1;
      const items: string[] = [];
      while (j < lines.length && /^\s+-\s/.test(lines[j])) {
        const bm = lines[j].match(/^\s*-\s*(.+?)\s*$/);
        if (!bm) break;
        items.push(unquote(bm[1]));
        j++;
      }
      if (items.length) {
        out[key] = items;
        i = j;
        continue;
      }

      // Nested object — one level of `<indent>subkey: ...` lines.
      const nested: Record<string, unknown> = {};
      while (j < lines.length) {
        const childMatch = lines[j].match(/^\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
        if (!childMatch) break;
        const childKey = childMatch[1];
        const childRest = childMatch[2];
        if (childRest === '') {
          const childItems: string[] = [];
          let k = j + 1;
          while (k < lines.length && /^\s+-\s/.test(lines[k])) {
            const bm = lines[k].match(/^\s*-\s*(.+?)\s*$/);
            if (!bm) break;
            childItems.push(unquote(bm[1]));
            k++;
          }
          nested[childKey] = childItems;
          j = k;
        } else if (childRest.startsWith('[') && childRest.endsWith(']')) {
          const inner = childRest.slice(1, -1).trim();
          nested[childKey] = inner ? inner.split(',').map((s) => unquote(s.trim())).filter(Boolean) : [];
          j++;
        } else {
          nested[childKey] = unquote(childRest);
          j++;
        }
      }
      if (Object.keys(nested).length > 0) {
        out[key] = nested;
        i = j;
        continue;
      }

      out[key] = '';
      i++;
      continue;
    }

    // Inline array: [a, b]
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      out[key] = inner
        ? inner.split(',').map((s) => unquote(s.trim())).filter(Boolean)
        : [];
      i++;
      continue;
    }

    // Scalar
    out[key] = unquote(rest);
    i++;
  }
  return out;
}

function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

// ─── Parse a single markdown file ────────────────────────────────

export function parseSkillMarkdown(content: string, path: string): ParsedSkillFile {
  const match = content.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error(`Missing YAML frontmatter in ${path}`);
  const frontmatter = parseFrontmatterYaml(match[1]);
  const body = (match[2] ?? '').trim();
  const kind: 'skill' | 'command' =
    path.startsWith('commands/') || path.includes('/commands/') ? 'command' : 'skill';
  return { kind, frontmatter, body, path };
}

// ─── Convert to UpsertSkillInput ─────────────────────────────────

function deriveName(parsed: ParsedSkillFile): string {
  const fm = parsed.frontmatter.name;
  if (typeof fm === 'string' && fm.trim()) return fm.trim();
  // Fall back to filename for commands that omit `name`.
  const base = parsed.path.split('/').pop() ?? 'skill';
  return base.replace(/\.md$/, '');
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
}

export function toSkillDefinition(opts: {
  parsed: ParsedSkillFile;
  namespace: string;
  extractedBaseDir: string;
  referenceFiles: string[];
}): UpsertSkillInput {
  const { parsed, namespace, referenceFiles } = opts;
  const baseName = deriveName(parsed);
  const id = slugify(`${namespace}-${baseName}`).slice(0, 64) || `${namespace}-skill`;

  const refsSection =
    parsed.kind === 'skill' && referenceFiles.length
      ? `\n\n## Available references (load via Read tool when needed)\n\n${referenceFiles
          .map((p) => `- \`${p}\``)
          .join('\n')}`
      : '';

  const allowedTools = Array.isArray(parsed.frontmatter['allowed-tools'])
    ? (parsed.frontmatter['allowed-tools'] as string[])
    : null;

  return {
    id,
    name: baseName,
    description:
      typeof parsed.frontmatter.description === 'string'
        ? parsed.frontmatter.description
        : '',
    slash_command: parsed.kind === 'command' ? `${namespace}:${baseName}` : null,
    prompt_body: parsed.body + refsSection,
    scope: 'global',
    enabled: true,
    allowed_tools: allowedTools,
    model_override: null,
    provider_override: null,
    context_mode: parsed.kind === 'command' ? 'tool' : 'auto',
    variables: parsed.kind === 'command' ? ['USER_INPUT'] : [],
    sort_order: 100,
    tags: [namespace, 'imported'],
    path_patterns: null,
    author: namespace,
    version: '1.0.0',
    source: 'imported',
  };
}
