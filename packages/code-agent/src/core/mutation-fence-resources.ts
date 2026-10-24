import {
  basename,
  dirname,
  isAbsolute,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { diagnosticExecutables } from '../tools/diagnostic-checkers.js';
import {
  asAgentRunId,
  type AgentRunId,
  type EnvironmentId,
  type ExecutionEnvironmentRef,
  type ResourceBinding,
  type ResourceConstraint,
  type WorkspaceLease,
  type WorkspaceLeaseId,
} from '@mcp/agent-runtime-contracts';
import {
  bindResource,
  revalidateBinding,
  type ResourceBindingInputResource,
} from './resource-binding.js';
import type {
  ToolEffectBoundaryKind,
  ToolMutationEffect,
  ToolMutationFence,
} from './tool.js';
import type { MutationFenceAuthorityOptions } from './mutation-fence-types.js';
export class MutationFenceError extends Error {
  constructor(readonly reasonCode: string, detail: string) {
    super(`mutation-fence ${reasonCode}: ${detail}`);
    this.name = 'MutationFenceError';
  }
}


export function commandHead(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return '';
  const quoted = trimmed.match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  return (quoted?.[1] ?? quoted?.[2] ?? quoted?.[3] ?? '').toLowerCase();
}


export function sqlOperation(sql: unknown): string {
  return typeof sql === 'string'
    ? (sql.trim().match(/^([a-z]+)/i)?.[1] ?? 'unknown').toLowerCase()
    : 'unknown';
}


export function collectPathInputs(
  toolName: string,
  input: Record<string, unknown>,
): ResourceBindingInputResource[] {
  const paths = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) paths.add(value.trim());
  };
  for (const key of [
    'path',
    'file_path',
    'target',
    'destination',
    'from_path',
    'to_path',
    'move_path',
    'old_path',
    'new_path',
  ]) {
    add(input[key]);
  }
  if (Array.isArray(input.paths)) {
    for (const value of input.paths) add(value);
  }
  if (toolName === 'apply_patch') {
    const patch = typeof input.patch === 'string'
      ? input.patch
      : typeof input._raw === 'string'
        ? input._raw
        : '';
    for (const match of patch.matchAll(
      /^\*\*\* (?:(?:Add|Update|Delete) File:|Move to:)\s*(.+)$/gm,
    )) {
      add(match[1]);
    }
  }
  if ((toolName === 'diagram_create' || toolName === 'diagram_update' || toolName === 'diagram_export')
    && typeof input.name === 'string') {
    const base = (toolName === 'diagram_export' && typeof input.output_name === 'string' ? input.output_name : input.name)
      .trim()
      .replace(/^.*[\\/]/, '')
      .replace(/\.drawio$/i, '');
    const slug = base
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'diagram';
    add(`diagrams/${slug}.${toolName === 'diagram_export' && input.format === 'png' ? 'png' : toolName === 'diagram_export' ? 'svg' : 'drawio'}`);
  }
  if (toolName === 'submit_spec') add('.mcp/specs');
  return Array.from(paths, (path) => ({
    kind: 'path' as const,
    path,
    access: 'write' as const,
    followSymlinks: false,
  }));
}


export function resourcesForInvocation(
  boundary: ToolEffectBoundaryKind,
  toolName: string,
  input: Record<string, unknown>,
): ResourceBindingInputResource[] {
  switch (boundary) {
    case 'filesystem':
      return collectPathInputs(toolName, input);
    case 'shell': {
      if (toolName === 'get_diagnostics') return diagnosticExecutables(String(input.file_path ?? ''))
        .map(executable => ({ kind: 'command' as const, executable }));
      const executable = toolName.startsWith('git_') || toolName === 'enter_worktree' || toolName === 'exit_worktree'
        ? 'git'
        : commandHead(String(input.command ?? input.cmd ?? ''));
      return executable
        ? [{ kind: 'command', executable }]
        : [];
    }
    case 'network': {
      try {
        const url = new URL(String(input.url ?? ''));
        return [{
          kind: 'network',
          domains: [url.hostname.toLowerCase()],
          methods: [String(input.method ?? 'GET').toUpperCase()],
        }];
      } catch {
        return [];
      }
    }
    case 'database': {
      if (toolName === 'mcp__save_memory') return [{ kind: 'database', databaseId: 'memory:project', operations: ['save_memory.save'] }];
      if (toolName === 'remember' || toolName === 'forget_memory') return [{
        kind: 'database', databaseId: `memory:${input.scope === 'user' ? 'user' : 'project'}`,
        operations: [toolName === 'remember' ? 'remember.save' : 'forget_memory.archive'],
      }];
      const operation = toolName === 'db_list' ? 'list' : toolName === 'db_schema' ? 'schema' : toolName === 'db_query'
        ? sqlOperation(input.sql)
        : typeof (input.command as { op?: unknown } | undefined)?.op === 'string'
          ? String((input.command as { op: string }).op).toLowerCase()
          : Array.isArray((input.command as { args?: unknown[] } | undefined)?.args)
            ? String((input.command as { args: unknown[] }).args[0] ?? 'unknown').toLowerCase()
            : 'unknown';
      return [{
        kind: 'database',
        databaseId: String(input.connection ?? '<default>'),
        operations: [operation],
      }];
    }
    case 'external_mcp':
      return [{ kind: 'application', appId: toolName, operations: ['tools/call'] }];
    case 'control':
      if (toolName === 'mcp__export_docs') return [{ kind: 'application', appId: toolName, operations: ['export/publish'] }];
      if (toolName === 'mcp__index_project') return [{ kind: 'application', appId: toolName, operations: ['index/reconcile'] }];
      if (toolName.startsWith('preview_')) return [{ kind: 'application', appId: toolName, operations: ['preview/dispatch'] }];
      if (toolName.startsWith('browser_')) return [{ kind: 'application', appId: toolName, operations: ['browser/dispatch'] }];
      return [];
    case 'nested':
      return [];
  }
}


export function normalizedAbsolute(path: string): string {
  return normalize(isAbsolute(path) ? path : resolve(path));
}


export function samePhysicalPath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
}


export function pathInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}


/**
 * Canonicalize a host path without following a project-internal symlink or
 * junction. Missing leaf components are allowed, but their nearest existing
 * ancestor must map to the same location under the canonical project root.
 * Remote/container ports are not attested in ENFORCE and therefore never
 * reach this host-only boundary.
 */
export function canonicalHostPath(rawPath: string, root: string): {
  root: string;
  candidate: string;
} {
  const lexicalRoot = normalizedAbsolute(root);
  const lexicalCandidate = normalizedAbsolute(
    isAbsolute(rawPath) ? rawPath : resolve(lexicalRoot, rawPath),
  );
  if (!pathInside(lexicalCandidate, lexicalRoot)) {
    throw new MutationFenceError('path_escape', `${rawPath} resolves outside ${root}`);
  }
  if (!existsSync(lexicalRoot)) {
    // Lightweight unit-test/future-create roots. Real coder project roots
    // already exist; their path components are checked below.
    return { root: lexicalRoot, candidate: lexicalCandidate };
  }
  const canonicalRoot = normalize(realpathSync(lexicalRoot));
  let existing = lexicalCandidate;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) {
      throw new MutationFenceError('path_unresolvable', `${rawPath} has no existing ancestor`);
    }
    missing.unshift(basename(existing));
    existing = parent;
  }
  const canonicalExisting = normalize(realpathSync(existing));
  const canonicalCandidate = normalize(resolve(canonicalExisting, ...missing));
  const rel = relative(lexicalRoot, lexicalCandidate);
  const expectedWithoutLinks = normalize(resolve(canonicalRoot, rel));
  if (!samePhysicalPath(canonicalCandidate, expectedWithoutLinks)) {
    throw new MutationFenceError(
      'symlink_not_allowed',
      `${rawPath} traverses a symlink or junction inside the delegated root`,
    );
  }
  if (!pathInside(canonicalCandidate, canonicalRoot)) {
    throw new MutationFenceError('path_escape', `${rawPath} escapes the canonical delegated root`);
  }
  return { root: canonicalRoot, candidate: canonicalCandidate };
}


export function filesystemRoots(
  options: MutationFenceAuthorityOptions,
): ReadonlyArray<{
  rootPath: string;
  aliases: ReadonlyArray<string>;
  access: 'read' | 'write';
}> {
  const configured = options.filesystemRoots ?? [];
  const roots = [
    {
      rootPath: options.authorizedRoot,
      aliases: options.authorizedRootAliases ?? [],
      access: 'write' as const,
    },
    ...configured.map((root) => ({
      rootPath: root.rootPath,
      aliases: root.aliases ?? [],
      access: root.access ?? 'write' as const,
    })),
  ];
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = normalizedAbsolute(root.rootPath).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}


export function rootForPath(
  options: MutationFenceAuthorityOptions,
  input: Record<string, unknown>,
  rawPath: string,
): { rootPath: string; pathWithinRoot: string } {
  const roots = filesystemRoots(options).filter((root) => root.access === 'write');
  if (isAbsolute(rawPath)) {
    const candidate = normalizedAbsolute(rawPath);
    const matches = roots
      .filter((root) => pathInside(candidate, normalizedAbsolute(root.rootPath)))
      .sort((a, b) => b.rootPath.length - a.rootPath.length);
    if (matches[0]) return { rootPath: matches[0].rootPath, pathWithinRoot: rawPath };
    throw new MutationFenceError(
      'path_escape',
      `${rawPath} is outside every delegated writable root`,
    );
  }
  const requested = typeof input.project === 'string'
    ? input.project.trim()
    : typeof input.project_name === 'string'
      ? input.project_name.trim()
      : '';
  if (requested) {
    const selected = roots.find((root) => root.aliases.includes(requested));
    if (selected) return { rootPath: selected.rootPath, pathWithinRoot: rawPath };
  }
  const normalized = rawPath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  const slash = normalized.indexOf('/');
  const prefix = slash >= 0 ? normalized.slice(0, slash) : normalized;
  const selected = roots.find((root) =>
    root.aliases.some((alias) => alias.toLowerCase() === prefix.toLowerCase()));
  if (selected) {
    return {
      rootPath: selected.rootPath,
      pathWithinRoot: slash >= 0 ? normalized.slice(slash + 1) || '.' : '.',
    };
  }
  return { rootPath: options.authorizedRoot, pathWithinRoot: rawPath };
}


export function resourceMatches(
  binding: ResourceBinding,
  effect: ToolMutationEffect,
): boolean {
  switch (effect.kind) {
    case 'filesystem': {
      if (!effect.resource) return false;
      const candidate = normalizedAbsolute(effect.resource);
      const paths = binding.canonicalResources.filter(
        (resource): resource is Extract<ResourceConstraint, { kind: 'path' }> =>
          resource.kind === 'path' && resource.access === 'write',
      );
      if (effect.operation === 'mkdir') {
        // write_file commonly creates the already-bound target's parent first.
        return paths.some((resource) =>
          samePhysicalPath(candidate, normalizedAbsolute(resource.root))
          || pathInside(normalizedAbsolute(resource.root), candidate));
      }
      return paths.some((resource) => samePhysicalPath(candidate, normalizedAbsolute(resource.root)));
    }
    case 'shell': {
      const executable = commandHead(effect.resource ?? effect.operation);
      return binding.canonicalResources.some((resource) =>
        resource.kind === 'command'
        && commandHead(resource.executable) === executable);
    }
    case 'network': {
      if (!effect.resource) return false;
      try {
        const host = new URL(effect.resource).hostname.toLowerCase();
        const method = effect.operation.toUpperCase();
        return binding.canonicalResources.some((resource) =>
          resource.kind === 'network'
          && resource.domains.map((domain) => domain.toLowerCase()).includes(host)
          && (!resource.methods
            || resource.methods.map((item) => item.toUpperCase()).includes(method)));
      } catch {
        return false;
      }
    }
    case 'database':
      return binding.canonicalResources.some((resource) =>
        resource.kind === 'database'
        && resource.databaseId === (effect.resource ?? '<default>')
        && resource.operations.map((operation) => operation.toLowerCase())
          .includes(effect.operation.toLowerCase()));
    case 'external_mcp':
      return effect.operation === 'tools/call' && binding.canonicalResources.some(resource =>
        resource.kind === 'application' && resource.appId === effect.resource && resource.operations.includes('tools/call'));
    case 'control':
      if (binding.canonicalResources.some(resource => resource.kind === 'application' && resource.appId === 'mcp__export_docs')) {
        // Registry entry and the owned publication port both revalidate the
        // same binding. Neither check may authorize a different resource.
        return effect.resource === 'mcp__export_docs'
          && (effect.operation === 'mcp__export_docs' || effect.operation === 'export/publish');
      }
      if (binding.canonicalResources.some(resource => resource.kind === 'application' && resource.appId === 'mcp__index_project')) {
        return effect.resource === 'mcp__index_project'
          && (effect.operation === 'mcp__index_project' || effect.operation === 'index/reconcile');
      }
      return true;
  }
}


export function derivedFilesystemEffectMatches(
  options: MutationFenceAuthorityOptions,
  invocation: {
    effectiveInput: Record<string, unknown>;
    toolName: string;
  },
  binding: ResourceBinding,
  effect: ToolMutationEffect,
): boolean {
  if (effect.kind === 'filesystem'
    && invocation.toolName === 'submit_spec'
    && effect.resource
    && (effect.operation === 'mkdir' || effect.operation === 'createFile')) {
    const candidate = normalizedAbsolute(effect.resource);
    const slug = String(invocation.effectiveInput.name ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'spec';
    return filesystemRoots(options).some((root) => {
      if (root.access !== 'write') return false;
      const specsRoot = resolve(normalizedAbsolute(root.rootPath), '.mcp', 'specs');
      if (effect.operation === 'mkdir') return candidate === specsRoot;
      if (!pathInside(candidate, specsRoot)) return false;
      const relativeName = relative(specsRoot, candidate).replace(/\\/g, '/');
      return new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\.md$`)
        .test(relativeName);
    });
  }
  if (effect.kind !== 'filesystem'
    || invocation.toolName !== 'manage_path'
    || invocation.effectiveInput.operation !== 'delete'
    || invocation.effectiveInput.delete_mode === 'permanent'
    || (effect.operation !== 'mkdir' && effect.operation !== 'rename')
    || !effect.resource) {
    return false;
  }
  const candidate = normalizedAbsolute(effect.resource);
  const sourcePaths = binding.canonicalResources.filter(
    (resource): resource is Extract<ResourceConstraint, { kind: 'path' }> =>
      resource.kind === 'path' && resource.access === 'write',
  );
  return filesystemRoots(options).some((root) => {
    if (root.access !== 'write') return false;
    const normalizedRoot = normalizedAbsolute(root.rootPath);
    const trashRoot = resolve(normalizedRoot, '.mcp-indexer', 'trash');
    const sourceInRoot = sourcePaths.some((source) =>
      pathInside(normalizedAbsolute(source.root), normalizedRoot));
    return sourceInRoot && pathInside(candidate, trashRoot);
  });
}
