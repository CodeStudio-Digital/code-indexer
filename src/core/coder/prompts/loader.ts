import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prompt loader — reads *.txt files from this directory once at startup and
 * caches them in memory. Interpolation is plain `{{var}}` substitution; no
 * conditionals, no loops (that'd defeat the purpose of separating prompts
 * from code). For conditional sections, assemble them in the caller and
 * inject as a single `{{section}}` variable.
 *
 * In dev, set `CODER_PROMPTS_WATCH=1` to hot-reload prompts on disk change.
 * The system prompt is rebuilt per session (not per turn), so picking up
 * edits only requires starting a new session.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** In-memory cache keyed by prompt file name (without .txt). */
const cache = new Map<string, string>();
const watchers = new Map<string, FSWatcher>();

function resolvePromptPath(name: string): string {
  // Prefer the source .txt next to loader.ts. When compiled to dist/, the
  // source .txt isn't copied by tsc — fall back to the project src/ path via
  // a relative jump from dist/core/coder/prompts/ → src/core/coder/prompts/.
  const direct = resolve(HERE, `${name}.txt`);
  try {
    readFileSync(direct);
    return direct;
  } catch {
    // Compiled path fallback — dist/core/coder/prompts/loader.js up to repo root, then into src.
    const fallback = resolve(HERE, '../../../../src/core/coder/prompts', `${name}.txt`);
    return fallback;
  }
}

function readPromptFromDisk(name: string): string {
  const path = resolvePromptPath(name);
  return readFileSync(path, 'utf-8');
}

/**
 * Load a prompt by name. Caches the result. If CODER_PROMPTS_WATCH=1, sets
 * up an fs.watch on the underlying file and invalidates the cache on change.
 */
export function loadPrompt(name: string): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const content = readPromptFromDisk(name);
  cache.set(name, content);
  if (process.env.CODER_PROMPTS_WATCH === '1' && !watchers.has(name)) {
    try {
      const path = resolvePromptPath(name);
      const w = watch(path, { persistent: false }, () => {
        cache.delete(name);
        console.log(`[coder] prompt '${name}' invalidated — next buildSystemPrompt() will re-read from disk`);
      });
      watchers.set(name, w);
    } catch (e) {
      console.warn(`[coder] prompt watch for '${name}' failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return content;
}

/**
 * Substitute `{{key}}` placeholders in `template` with values from `vars`.
 * Missing keys are replaced with an empty string and logged once. No escaping,
 * no conditionals — keep it simple.
 */
export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key) => {
    const v = vars[key];
    if (v === undefined) {
      console.warn(`[coder] prompt interpolation: missing variable '${key}'`);
      return '';
    }
    return v;
  });
}

/** Clear the cache — used by tests that modify prompts on disk. */
export function _resetPromptCache(): void {
  cache.clear();
  for (const w of watchers.values()) w.close();
  watchers.clear();
}
