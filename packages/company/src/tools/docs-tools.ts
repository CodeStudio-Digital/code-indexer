/**
 * Documentation tools — available to master AND subordinates in builder
 * sessions (when a sandbox binding is attached). Agents use these to
 * record ADRs, API docs, runbooks and architectural notes inside the
 * project's `docs/` tree, maintaining a browsable `docs/index.json` the
 * dashboard's Docs tab renders.
 *
 * Storage: the sandbox filesystem is the working copy; the company
 * drive (`__docs__/<service>/<path>`) is the durable mirror. Sandbox
 * lifecycle (destroy / restart / scaffolder rewipe) used to wipe docs
 * with the container — the mirror means they survive. Reads fall back
 * to the drive when the sandbox doesn't have the file, so an agent
 * spawning into a freshly-recreated container still sees prior ADRs.
 *
 * `service` parameter: every tool accepts an optional serviceId. When
 * omitted, docs land in the primary sandbox. Specifying a serviceId
 * routes to that microservice's container.
 */

import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { SandboxBinding } from '@mcp/company/types.js';
import type { CompanyDriveStore } from '@mcp/company/services/CompanyDriveStore.js';
import { getSandboxManager } from '@mcp/services/sandbox/index.js';
import { resolveDriver } from '@mcp/services/sandbox/drivers/driver-factory.js';
import { checkRelativePath, DOCS_CONTENT_CAP_BYTES, DOCS_MIRROR_PREFIX } from './file-path-core.js';

const MAX_CONTENT_BYTES = DOCS_CONTENT_CAP_BYTES;

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
  // Sandbox manager keys services by the ROOT session id (sub-sessions
  // share the parent's container). Resolve to effective id so a tool
  // running inside a child orchestrator finds the parent's service.
  const orchEff = (ctx.companyContext?.orchestrator as { effectiveSessionId?: number } | undefined)?.effectiveSessionId;
  const sessionId = String(orchEff ?? ctx.companyContext?.companySessionId ?? '');
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
 * clobber source files. Rules are shared with the drive via
 * `file-path-core` — docs keep the stricter SUBSTRING `..` rejection.
 * Returns the absolute container path when the input is acceptable, or
 * null when it's not.
 */
function resolveDocPath(binding: SandboxBinding, relPath: string): string | null {
  const clean = relPath.trim();
  const check = checkRelativePath(clean, { traversal: 'substring' });
  if (!check.ok) return null;
  return `${binding.workdir}/docs/${clean}`;
}

/**
 * Build the drive-mirror path for a doc. We namespace by serviceId so
 * docs/api/* and docs/frontend/* from different microservices don't
 * collide in the operator's Drive tab — the prefix doubles as
 * documentation of where the file came from.
 */
function driveMirrorPath(serviceId: string | undefined, relPath: string): string {
  const svc = serviceId && serviceId !== 'main' ? serviceId : 'main';
  return `${DOCS_MIRROR_PREFIX}${svc}/${relPath}`;
}

/**
 * Locate the company drive store via the orchestrator on `ctx`. Returns
 * null when the context doesn't carry one — agent tools called from
 * tests / non-orchestrated runners gracefully degrade to "sandbox only"
 * behavior; the production builder path always has it wired.
 */
function resolveDriveStore(ctx: ToolContext): CompanyDriveStore | null {
  const orch = ctx.companyContext?.orchestrator as { driveStore?: CompanyDriveStore } | undefined;
  return orch?.driveStore ?? null;
}

/**
 * Mirror a doc write into the drive — best-effort. Failures are logged
 * but never bubble up: the sandbox write already succeeded and the
 * drive mirror is a durability optimization, not a correctness gate.
 */
function mirrorWriteToDrive(
  ctx: ToolContext,
  binding: SandboxBinding,
  relPath: string,
  content: string,
): void {
  const drive = resolveDriveStore(ctx);
  if (!drive) return;
  try {
    const scope = drive.resolveScopeKey();
    drive.write(scope, driveMirrorPath(binding.serviceId, relPath), content, {
      role: ctx.companyContext?.agentRole ?? null,
      agentRunId: ctx.companyContext?.agentRunId ?? null,
    });
  } catch (e) {
    console.warn(
      `[docs-tools] drive mirror write failed for ${relPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Mirror a doc delete — same best-effort semantics as the write path. */
function mirrorDeleteFromDrive(
  ctx: ToolContext,
  binding: SandboxBinding,
  relPath: string,
): void {
  const drive = resolveDriveStore(ctx);
  if (!drive) return;
  try {
    drive.delete(drive.resolveScopeKey(), driveMirrorPath(binding.serviceId, relPath));
  } catch (e) {
    console.warn(
      `[docs-tools] drive mirror delete failed for ${relPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Try reading a doc from the drive mirror — used as fallback when the
 * sandbox has been destroyed/restarted and the file is no longer on
 * disk. Returns null when the drive has no copy either.
 */
function readFromDriveMirror(
  ctx: ToolContext,
  binding: SandboxBinding,
  relPath: string,
): string | null {
  const drive = resolveDriveStore(ctx);
  if (!drive) return null;
  try {
    const scope = drive.resolveScopeKey();
    const result = drive.read(scope, driveMirrorPath(binding.serviceId, relPath), {
      maxBytes: MAX_CONTENT_BYTES,
    });
    return result.content;
  } catch {
    return null;
  }
}

const docsWrite: CoderTool = {
  name: 'docs_write',
  description:
    'Create or overwrite a markdown documentation file inside the sandbox. ' +
    'THIS is the tool for LIVING DOCUMENTATION per service (ADRs, API references, runbooks, ' +
    'architecture notes) — it mirrors to the durable company drive and shows in the Docs tab. ' +
    'For work artifacts (specs, dumps, reports) use `write_shared_file` instead. ' +
    'Path is always relative to `<workdir>/docs/` (e.g. `decisions/0001-auth.md`, ' +
    '`api/endpoints.md`). Parent directories are created automatically. ' +
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
    mirrorWriteToDrive(ctx, res.binding, path, content);
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
    const relPath = String(args.path ?? '');
    const abs = resolveDocPath(res.binding, relPath);
    if (!abs) return err(`docs_read: invalid path`);
    try {
      const text = await res.binding.driver.readFile(res.binding.containerId, abs);
      return ok(text);
    } catch (e) {
      // Sandbox no longer has the file — common after restart / destroy.
      // Fall back to the drive mirror so the agent can still see prior
      // documentation it (or a peer) wrote before the restart.
      const mirrored = readFromDriveMirror(ctx, res.binding, relPath);
      if (mirrored !== null) return ok(mirrored);
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
    'Rewrite the docs index — the table of contents the dashboard\'s Docs tab uses to render a ' +
    'navigable tree.\n' +
    'Target file is `docs/index.json`. Pass a JSON array of entries; each entry has `title`, `path` (relative to docs/), ' +
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
    mirrorWriteToDrive(ctx, res.binding, 'index.json', body);
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
    const relPath = String(args.path ?? '');
    const abs = resolveDocPath(res.binding, relPath);
    if (!abs) return err('docs_delete: invalid path');
    const probe = await res.binding.driver.exec(
      res.binding.containerId,
      `rm -f ${JSON.stringify(abs)}`,
      { cwd: res.binding.workdir, timeoutMs: 5_000 },
    );
    if (probe.exitCode !== 0) {
      return err(`docs_delete: ${probe.stderr || probe.stdout || 'unknown failure'}`);
    }
    mirrorDeleteFromDrive(ctx, res.binding, relPath);
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
