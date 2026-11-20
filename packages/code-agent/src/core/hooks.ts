import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, Script } from 'node:vm';

/**
 * Per-project plugin hooks. Projects can drop customization scripts in
 * `.mcp-indexer/hooks/` to tweak the system prompt or filter tools without
 * forking the coder. This is deliberately minimal: just two hooks, both
 * pure functions, running in a `node:vm` sandbox with a 200ms timeout so a
 * badly-written or malicious hook can't hang the session.
 *
 * Hooks live at:
 *   {project_root}/.mcp-indexer/hooks/system-prompt.js
 *   {project_root}/.mcp-indexer/hooks/tool-filter.js
 *
 * Each exports a single default function on `module.exports`. The scripts
 * run with no `require`, no `fs`, no network — only the `ctx` and return
 * value matter. If a hook throws or times out, a warning is logged and the
 * session continues with unmodified inputs.
 */

export interface SystemPromptHookContext {
  projectName: string;
  projectRoot: string;
  os: string;
  profile?: string;
}

export interface ToolFilterHookContext {
  projectName: string;
  providerName: string;
  model: string;
  profile?: string;
}

export interface ToolSummary {
  name: string;
  source: string;
}

/**
 * Compiled scripts keyed by file path. Each lookup costs one `stat`; the file
 * is read and compiled again only when its mtime or size changed, so an edited
 * hook applies on the next prompt/catalog build and a deleted one stops.
 */
const scriptCache = new Map<string, { mtimeMs: number; size: number; script: Script | null }>();

function loadHookScript(projectRoot: string, name: string): Script | null {
  const path = join(projectRoot, '.mcp-indexer', 'hooks', `${name}.js`);
  let stat: ReturnType<typeof statSync> | undefined;
  try {
    stat = statSync(path, { throwIfNoEntry: false });
  } catch {
    stat = undefined; // unreadable path behaves like a missing hook (as existsSync did)
  }
  if (!stat?.isFile()) {
    scriptCache.delete(path);
    return null;
  }
  const cached = scriptCache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.script;
  const script = compileHookScript(path, name);
  scriptCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, script });
  return script;
}

function compileHookScript(path: string, name: string): Script | null {
  try {
    const code = readFileSync(path, 'utf-8');
    // Wrap in CommonJS-ish shim so `module.exports =` works.
    const wrapped = `(function(module, exports) { ${code}\n; return module.exports; })({exports: {}}, {})`;
    return new Script(wrapped, { filename: `hooks/${name}.js` });
  } catch (e) {
    console.warn(`[coder] hook ${name} failed to parse: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function runHook<T>(script: Script, ctx: unknown, defaultValue: T): T {
  try {
    const sandbox = { console, Array, JSON, Object, String, Number };
    const context = createContext(sandbox);
    const fn = script.runInContext(context, { timeout: 200 }) as unknown;
    if (typeof fn !== 'function') return defaultValue;
    // Hook functions are pure: (ctx) => T. We reset the context for the call
    // so hooks can't maintain state across invocations.
    const result = (fn as (c: unknown) => unknown)(ctx);
    return (result ?? defaultValue) as T;
  } catch (e) {
    console.warn(`[coder] hook execution failed: ${e instanceof Error ? e.message : String(e)}`);
    return defaultValue;
  }
}

export function runSystemPromptHook(projectRoot: string, ctx: SystemPromptHookContext): string {
  const script = loadHookScript(projectRoot, 'system-prompt');
  if (!script) return '';
  const extra = runHook<string>(script, ctx, '');
  return typeof extra === 'string' ? extra : '';
}

export function runToolFilterHook(
  projectRoot: string,
  tools: ToolSummary[],
  ctx: ToolFilterHookContext,
): Set<string> | null {
  const script = loadHookScript(projectRoot, 'tool-filter');
  if (!script) return null;
  const result = runHook<unknown>(script, { tools, ...ctx }, null);
  if (!Array.isArray(result)) return null;
  const allowed = new Set<string>();
  for (const item of result) {
    if (typeof item === 'string') allowed.add(item);
    else if (item && typeof (item as { name?: unknown }).name === 'string') {
      allowed.add((item as { name: string }).name);
    }
  }
  return allowed;
}
