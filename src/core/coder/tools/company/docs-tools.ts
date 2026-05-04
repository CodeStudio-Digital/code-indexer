/**
 * Documentation tools — available to master AND subordinates in builder
 * sessions (when a sandbox binding is attached). Agents use these to
 * record ADRs, API docs, runbooks and architectural notes inside the
 * project's `docs/` tree, maintaining a browsable `docs/index.json` the
 * dashboard's Docs tab renders.
 *
 * Storage is the sandbox filesystem itself (per service): there is no
 * separate DB table. This keeps docs versioned together with the code
 * and avoids dual-write consistency problems. The dashboard reads
 * through a read-only HTTP proxy backed by the same driver.
 *
 * `service` parameter: every tool accepts an optional serviceId. When
 * omitted, docs land in the primary sandbox. Specifying a serviceId
 * routes to that microservice's container (e.g. documentation living
 * alongside the `api` worker code, separate from the `frontend`).
 */

import type { CoderTool, ToolContext, ToolResult } from '../../core/tool.js';
import { ok, err } from '../../core/tool.js';
import type { SandboxBinding } from '../../company/types.js';
import { getSandboxManager } from '../../../sandbox/index.js';
import { resolveDriver } from '../../../sandbox/drivers/driver-factory.js';

const MAX_CONTENT_BYTES = 256 * 1024;

/**
 * Resolve which sandbox the tool should target. Absent `serviceId`
 * always means "the primary sandbox attached to this agent"; a present
 * `serviceId` looks up the secondary container via the manager.
 *
 * Returns null (with an explanatory error string) when the session has
 * no sandbox at all, or when the named service doesn't exist.
 */
async function resolveTargetBinding(
  ctx: ToolContext,
  serviceId: string | undefined,
): Promise<{ binding: SandboxBinding } | { error: string }> {
  const primary = ctx.companyContext?.sandbox;
  if (!primary) {
    return {
      error:
        'Documentation tools are only available in builder-mode sessions. ' +
        'The company session for this agent has no sandbox attached.',
    };
  }
  if (!serviceId || serviceId === primary.serviceId || serviceId === 'main') {
    return { binding: primary };
  }
  const sessionId = String(ctx.companyContext?.companySessionId ?? '');
  if (!sessionId) return { error: 'No company session id in context' };
  const secondary = getSandboxManager().getService(sessionId, serviceId);
  if (!secondary || !secondary.containerId) {
    return { error: `Service '${serviceId}' not found on this session` };
  }
  const driver = await resolveDriver();
  return {
    binding: {
      driver,
      containerId: secondary.containerId,
      workdir: secondary.workdir,
      previewUrl: secondary.previewUrl,
      serviceId,
    },
  };
}

/**
 * Reject path traversal and absolute paths. Docs always live under
 * `<workdir>/docs/`; accepting `..` or leading `/` would let an agent
 * clobber source files. This function returns the absolute container
 * path when the input is acceptable, or null when it's not.
 */
function resolveDocPath(binding: SandboxBinding, relPath: string): string | null {
  const clean = relPath.trim();
  if (!clean || clean.startsWith('/') || clean.includes('..') || clean.includes('\0')) {
    return null;
  }
  return `${binding.workdir}/docs/${clean}`;
}

const docsWrite: CoderTool = {
  name: 'docs_write',
  description:
    'Create or overwrite a markdown documentation file inside the sandbox. ' +
    'Path is always relative to `<workdir>/docs/` (e.g. `decisions/0001-auth.md`, ' +
    '`api/endpoints.md`). Parent directories are created automatically. ' +
    'Use this for ADRs, API references, runbooks, or architecture notes. ' +
    'Prefer markdown with an optional YAML frontmatter (`--- title: … ---`) — ' +
    'the dashboard\'s Docs tab indexes frontmatter titles and tags.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Relative path under docs/, e.g. `decisions/0003-sandbox-layout.md`. Must not contain `..` or start with `/`.',
      },
      content: {
        type: 'string',
        description: 'Full markdown content. Optional YAML frontmatter recommended for the Docs UI.',
      },
      service: {
        type: 'string',
        description:
          'Optional service id (multi-service sessions). Defaults to the primary sandbox.',
      },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const res = await resolveTargetBinding(ctx, args.service as string | undefined);
    if ('error' in res) return err(res.error);
    const path = String(args.path ?? '');
    const content = String(args.content ?? '');
    if (content.length > MAX_CONTENT_BYTES) {
      return err(`docs_write: content exceeds ${MAX_CONTENT_BYTES} bytes`);
    }
    const abs = resolveDocPath(res.binding, path);
    if (!abs) return err(`docs_write: invalid path '${path}' (no traversal, no leading /)`);
    await res.binding.driver.writeFile(res.binding.containerId, abs, content, {
      recursive: true,
    });
    return ok(`Wrote docs/${path} (${content.length} bytes)`);
  },
};

const docsRead: CoderTool = {
  name: 'docs_read',
  description:
    'Read a markdown documentation file from the sandbox. Path is always relative to `<workdir>/docs/`. ' +
    'Use this before editing an ADR to preserve its history, or to pull prior architectural context ' +
    'into your current reasoning.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path under docs/' },
      service: { type: 'string', description: 'Optional service id.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const res = await resolveTargetBinding(ctx, args.service as string | undefined);
    if ('error' in res) return err(res.error);
    const abs = resolveDocPath(res.binding, String(args.path ?? ''));
    if (!abs) return err(`docs_read: invalid path`);
    try {
      const text = await res.binding.driver.readFile(res.binding.containerId, abs);
      return ok(text);
    } catch (e) {
      return err(`docs_read: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

const docsList: CoderTool = {
  name: 'docs_list',
  description:
    'List every markdown file under `<workdir>/docs/` in the sandbox (recursive). Use this to discover ' +
    'what documentation already exists before writing new notes (avoid duplicating ADRs). Returns ' +
    'newline-separated paths relative to docs/.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      service: { type: 'string', description: 'Optional service id.' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const res = await resolveTargetBinding(ctx, args.service as string | undefined);
    if ('error' in res) return err(res.error);
    // `find` is universally available in the sandbox base images we
    // ship; `2>/dev/null` silences "No such file" noise when docs/
    // hasn't been created yet, and `|| true` makes the exit clean.
    const probe = await res.binding.driver.exec(
      res.binding.containerId,
      `cd ${res.binding.workdir}/docs 2>/dev/null && find . -type f -name '*.md' 2>/dev/null | sed 's|^\\./||' || true`,
      { cwd: res.binding.workdir, timeoutMs: 5_000 },
    );
    const items = probe.stdout.split('\n').map((s) => s.trim()).filter(Boolean).sort();
    if (items.length === 0) return ok('(no docs yet — docs/ is empty or missing)');
    return ok(items.join('\n'));
  },
};

const docsIndexUpdate: CoderTool = {
  name: 'docs_index_update',
  description:
    'Rewrite `docs/index.json` — the table of contents the dashboard\'s Docs tab uses to render a ' +
    'navigable tree. Pass a JSON array of entries; each entry has `title`, `path` (relative to docs/), ' +
    'and optional `children` (recursive same shape). Keep entries in the order you want them shown. ' +
    'The schema is validated before writing — an invalid payload is rejected with the parse error.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      sections: {
        type: 'array',
        description: 'Top-level TOC entries.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            path: { type: 'string' },
            children: {
              type: 'array',
              description: 'Nested TOC entries.',
              items: {
                type: 'object',
                additionalProperties: true,
              },
            },
          },
          required: ['title'],
          additionalProperties: true,
        },
      },
      service: { type: 'string', description: 'Optional service id.' },
    },
    required: ['sections'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const res = await resolveTargetBinding(ctx, args.service as string | undefined);
    if ('error' in res) return err(res.error);
    const sections = args.sections;
    if (!Array.isArray(sections)) return err('docs_index_update: sections must be an array');
    type Entry = { title: string; path?: string; children?: Entry[] };
    const validate = (list: unknown[], depth: number): string | null => {
      if (depth > 6) return 'TOC nesting too deep (max 6 levels)';
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') return 'entry must be an object';
        const e = raw as Record<string, unknown>;
        if (typeof e.title !== 'string' || !e.title.trim()) return 'entry.title required';
        if (e.path !== undefined && typeof e.path !== 'string') return 'entry.path must be string';
        if (e.path && (e.path.startsWith('/') || e.path.includes('..'))) {
          return `entry.path '${e.path}' is not a safe relative path`;
        }
        if (e.children !== undefined) {
          if (!Array.isArray(e.children)) return 'entry.children must be array';
          const nested = validate(e.children, depth + 1);
          if (nested) return nested;
        }
      }
      return null;
    };
    const errMsg = validate(sections, 0);
    if (errMsg) return err(`docs_index_update: ${errMsg}`);
    const body = JSON.stringify({ sections }, null, 2);
    const abs = `${res.binding.workdir}/docs/index.json`;
    await res.binding.driver.writeFile(res.binding.containerId, abs, body, { recursive: true });
    return ok(`Updated docs/index.json (${(sections as Entry[]).length} top-level sections)`);
  },
};

const docsDelete: CoderTool = {
  name: 'docs_delete',
  description:
    'Delete a markdown file from the sandbox docs/. Use sparingly: prefer superseding an old ADR with ' +
    'a new one and linking between them. Only use delete for genuinely obsolete notes or typo-named ' +
    'files. Path is relative to docs/.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      service: { type: 'string' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const res = await resolveTargetBinding(ctx, args.service as string | undefined);
    if ('error' in res) return err(res.error);
    const abs = resolveDocPath(res.binding, String(args.path ?? ''));
    if (!abs) return err('docs_delete: invalid path');
    const probe = await res.binding.driver.exec(
      res.binding.containerId,
      `rm -f ${JSON.stringify(abs)}`,
      { cwd: res.binding.workdir, timeoutMs: 5_000 },
    );
    if (probe.exitCode !== 0) {
      return err(`docs_delete: ${probe.stderr || probe.stdout || 'unknown failure'}`);
    }
    return ok(`Deleted docs/${args.path}`);
  },
};

export const docsTools: CoderTool[] = [
  docsWrite,
  docsRead,
  docsList,
  docsIndexUpdate,
  docsDelete,
];
