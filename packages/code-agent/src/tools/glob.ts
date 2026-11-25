import { glob as fastGlob } from 'glob';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { setImmediate as yieldToHost } from 'node:timers/promises';
import { join, relative } from 'node:path';
import ignore from 'ignore';
import { minimatch } from 'minimatch';
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { resolveWorkspacePath } from '@mcp/code-agent/tools/paths.js';
import { truncationMarker } from '@mcp/code-agent/tools/truncation-marker.js';

/**
 * glob — fast filename pattern matching across the project tree.
 *
 * Fills a gap that `mcp__grep_code` (content search) and
 * `mcp__list_directory` (one level) both half-covered. A dedicated tool
 * removes the "which one do I use?" friction for a very common first step
 * of any refactor: "give me all files that look like X".
 *
 * - Respects `.gitignore` + `.mcpindexignore` by default (same logic as the
 *   scanner, so results line up with what gets indexed).
 * - Returns paths ordered by mtime descending — useful for "recently touched
 *   files matching Y".
 * - Hard cap on result count to keep output small; the agent can narrow the
 *   pattern if it hits the cap.
 */

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function loadIgnore(cwd: string): ignore.Ignore {
  const ig = ignore();
  // Boilerplate exclusions that should never surface to the agent, even if
  // neither gitignore nor mcpindexignore lists them.
  ig.add(['node_modules/', '.git/', 'dist/', '.mcp-indexer/']);
  const gitignore = join(cwd, '.gitignore');
  if (existsSync(gitignore)) {
    try {
      ig.add(readFileSync(gitignore, 'utf-8'));
    } catch {
      /* ignore */
    }
  }
  const mcpIgnore = join(cwd, '.mcpindexignore');
  if (existsSync(mcpIgnore)) {
    try {
      ig.add(readFileSync(mcpIgnore, 'utf-8'));
    } catch {
      /* ignore */
    }
  }
  return ig;
}

export const globTool: CoderTool = {
  name: 'glob',
  description:
    'Fast filename pattern matching across the project tree. Returns paths ordered by most-recent mtime.\n' +
    "USE: \"show me every **/*.test.ts\", \"all markdown under docs/\", \"which config files live in src/**\", as a first step before reading or editing a set of files.\n" +
    "USE: with mcp__grep_code when you need files matching a NAME pattern AND a content regex — glob first, then grep.\n" +
    "DON'T: use for content search — use mcp__grep_code (indexer-aware) or Grep.\n" +
    "DON'T: glob for one known path — just read_file it.\n" +
    "DON'T: pass absolute patterns. Patterns are relative to the selected search directory.\n" +
    'Respects .gitignore + .mcpindexignore by default (matching the indexer). Pass respect_ignore:false to bypass.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern. Examples: "**/*.ts", "src/**/*.test.*", "docs/**/*.md", "**/package.json".',
      },
      path: {
        type: 'string',
        description: 'Optional project-relative subdirectory or absolute path allowed by the session. In a global session use "<project-slug>/subdir".',
      },
      respect_ignore: {
        type: 'boolean',
        description: 'Whether to respect .gitignore and .mcpindexignore. Default true. Set false for admin-style sweeps.',
      },
      limit: {
        type: 'number',
        description: `Max paths to return (default ${DEFAULT_LIMIT}, hard max ${MAX_LIMIT}).`,
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const pattern = String(args.pattern ?? '').trim();
    if (!pattern) return err('pattern cannot be empty');
    if (pattern.startsWith('/')) {
      return err('absolute glob patterns are rejected — patterns are always relative to the project root');
    }
    const respectIgnore = args.respect_ignore !== false;
    const rawLimit = Number(args.limit) || DEFAULT_LIMIT;
    const limit = Math.min(Math.max(1, rawLimit), MAX_LIMIT);

    let searchRoot = ctx.cwd;
    let outputRoot = ctx.cwd;
    let externalSearch = false;
    let outputPrefix: string | undefined;
    if (args.path) {
      const subdir = String(args.path).trim();
      const resolved = resolveWorkspacePath(subdir, ctx, 'read');
      if (!resolved.ok) return err(resolved.reason);
      if (!existsSync(resolved.abs)) return err(`path not found: ${subdir}`);
      searchRoot = resolved.abs;
      outputRoot = resolved.rootPath;
      externalSearch = resolved.external;
      outputPrefix = resolved.workspacePrefix;
    }

    const filtered: Array<{ rel: string; mtime: number }> = [];
    let visited = 0;
    // Large ignored trees can contain tens of thousands of files. Yield while
    // collecting mtimes so evaluator heartbeats, cancellation and other chats
    // are not starved by an otherwise asynchronous glob.
    const checkpoint = async (): Promise<void> => {
      if (++visited % 64 !== 0) return;
      await yieldToHost();
      if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error('glob cancelled');
    };
    try {
      if (!args.path && ctx.globalWorkspace) {
        // Enumerate the real linked roots carried in ToolContext and expose
        // each result through the stable public `<project-slug>/...` namespace.
        for (const project of ctx.globalWorkspace.projects) {
          const matches = await fastGlob('**/*', {
            cwd: project.rootPath,
            nodir: true,
            dot: false,
            absolute: false,
          });
          const ig = respectIgnore ? loadIgnore(project.rootPath) : null;
          for (const relToProject of matches) {
            await checkpoint();
            const sourceRel = relToProject.split('\\').join('/');
            const projectRel = `${project.slug}/${sourceRel}`;
            if (!minimatch(projectRel, pattern)) continue;
            if (ig && ig.ignores(sourceRel)) continue;
            let mtime = 0;
            try { mtime = statSync(join(project.rootPath, relToProject)).mtimeMs; } catch { continue; }
            filtered.push({ rel: projectRel, mtime });
          }
        }
      } else {
        const matches = await fastGlob(pattern, {
          cwd: searchRoot,
          nodir: true,
          dot: false,
          absolute: false,
        });
        const ig = respectIgnore ? loadIgnore(outputRoot) : null;
        for (const relToRoot of matches) {
          await checkpoint();
          const absPath = join(searchRoot, relToRoot);
          const projectRel = relative(outputRoot, absPath).split('\\').join('/');
          if (ig && ig.ignores(projectRel)) continue;
          let mtime = 0;
          try { mtime = statSync(absPath).mtimeMs; } catch { continue; }
          filtered.push({
            rel: externalSearch
              ? absPath
              : outputPrefix
                ? `${outputPrefix}/${projectRel}`
                : projectRel,
            mtime,
          });
        }
      }
    } catch (e) {
      return err(`glob failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    filtered.sort((a, b) => b.mtime - a.mtime);

    const total = filtered.length;
    const capped = filtered.slice(0, limit);
    const lines = capped.map((m) => m.rel);
    const header = total > limit
      ? `${capped.length} of ${total} matches ${truncationMarker(`limit=${limit}`, 'narrow the pattern or raise limit')}`
      : `${total} match${total === 1 ? '' : 'es'}`;
    if (total === 0) {
      return ok(
        `No matches for pattern '${pattern}'${args.path ? ` under ${args.path}` : ''}. ` +
          'Check the pattern or try respect_ignore:false if you expected ignored files.',
      );
    }
    return {
      content: `${header}\n\n${lines.join('\n')}`,
      ...(total > limit
        ? {
            sourceTruncations: [{
              technique: 'glob-result-limit',
              inputSize: total,
              outputSize: capped.length,
              unit: 'items' as const,
              recoverable: true,
            }],
          }
        : {}),
    };
  },
};

export const globTools: CoderTool[] = [globTool];
