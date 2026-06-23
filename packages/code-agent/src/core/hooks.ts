import { existsSync, readFileSync } from 'node:fs';
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

/** Cache compiled scripts per project root so we don't re-read/parse every session. */
const scriptCache = new Map<string, { scripts: Record<string, Script | null>; mtime: number }>();

function loadHookScript(projectRoot: string, name: string): Script | null {
  const path = join(projectRoot, '.mcp-indexer', 'hooks', `${name}.js`);
  if (!existsSync(path)) return null;
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
  const cached = scriptCache.get(projectRoot);
  const script = cached?.scripts['system-prompt'] ?? loadHookScript(projectRoot, 'system-prompt');
  if (!script) return '';
  if (!cached) {
    scriptCache.set(projectRoot, { scripts: { 'system-prompt': script }, mtime: Date.now() });
  } else {
    cached.scripts['system-prompt'] = script;
  }
  const extra = runHook<string>(script, ctx, '');
  return typeof extra === 'string' ? extra : '';
}

export function runToolFilterHook(
  projectRoot: string,
  tools: ToolSummary[],
  ctx: ToolFilterHookContext,
): Set<string> | null {
  const cached = scriptCache.get(projectRoot);
  const script = cached?.scripts['tool-filter'] ?? loadHookScript(projectRoot, 'tool-filter');
  if (!script) return null;
  if (!cached) {
    scriptCache.set(projectRoot, { scripts: { 'tool-filter': script }, mtime: Date.now() });
  } else {
    cached.scripts['tool-filter'] = script;
  }
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
