import { createHash } from 'node:crypto';
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

export interface MutationFenceSnapshot {
  environmentId: string;
  environmentVersion: number;
  workspaceLeaseId?: string;
  workspaceLeaseVersion?: number;
  workspaceFencingEpoch?: number;
  ownerAgentRunId?: string;
}

export interface MutationFenceAuthorityOptions {
  mode: 'shadow' | 'enforce';
  /** Primary/default filesystem root for relative paths. */
  authorizedRoot: string;
  /** Public aliases (normally the primary project slug/name) for authorizedRoot. */
  authorizedRootAliases?: ReadonlyArray<string>;
  /**
   * All roots that may receive writes in this delegated context. Aliases map
   * the public `<project-slug>/...` namespace (and hidden legacy selectors) to
   * a linked real root; absolute paths use longest-prefix matching, including
   * writable external grants.
   */
  filesystemRoots?: ReadonlyArray<{
    rootPath: string;
    aliases?: ReadonlyArray<string>;
    access?: 'read' | 'write';
  }>;
  assertLease: () => void;
  snapshot: () => MutationFenceSnapshot;
  bindingTtlMs?: number;
  pollMs?: number;
  onViolation?: (error: Error) => void;
}

export class MutationFenceError extends Error {
  constructor(readonly reasonCode: string, detail: string) {
    super(`mutation-fence ${reasonCode}: ${detail}`);
    this.name = 'MutationFenceError';
  }
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

function commandHead(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return '';
  const quoted = trimmed.match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  return (quoted?.[1] ?? quoted?.[2] ?? quoted?.[3] ?? '').toLowerCase();
}

function sqlOperation(sql: unknown): string {
  return typeof sql === 'string'
    ? (sql.trim().match(/^([a-z]+)/i)?.[1] ?? 'unknown').toLowerCase()
    : 'unknown';
}

function collectPathInputs(
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
  if ((toolName === 'diagram_create' || toolName === 'diagram_update')
    && typeof input.name === 'string') {
    const base = input.name
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
    add(`diagrams/${slug}.drawio`);
  }
  if (toolName === 'submit_spec') add('.mcp/specs');
  return Array.from(paths, (path) => ({
    kind: 'path' as const,
    path,
    access: 'write' as const,
    followSymlinks: false,
  }));
}

function resourcesForInvocation(
  boundary: ToolEffectBoundaryKind,
  toolName: string,
  input: Record<string, unknown>,
): ResourceBindingInputResource[] {
  switch (boundary) {
    case 'filesystem':
      return collectPathInputs(toolName, input);
    case 'shell': {
      const executable = toolName.startsWith('git_')
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
      const operation = toolName === 'db_query'
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
    case 'control':
    case 'nested':
      return [];
  }
}

function environmentFor(
  snapshot: MutationFenceSnapshot,
  root: string,
): ExecutionEnvironmentRef {
  return {
    environmentId: snapshot.environmentId as EnvironmentId,
    kind: 'host',
    status: 'ready',
    projectId: 'coder',
    rootRef: root,
    cwdRef: root,
    version: snapshot.environmentVersion,
  };
}

function leaseFor(
  snapshot: MutationFenceSnapshot,
  root: string,
): WorkspaceLease | undefined {
  if (!snapshot.workspaceLeaseId) return undefined;
  if (!snapshot.ownerAgentRunId) {
    throw new MutationFenceError(
      'invalid_lease_owner',
      'workspace lease is missing its owner agent-run UUID',
    );
  }
  let ownerAgentRunId: AgentRunId;
  try {
    ownerAgentRunId = asAgentRunId(snapshot.ownerAgentRunId);
  } catch {
    throw new MutationFenceError(
      'invalid_lease_owner',
      'workspace lease owner must be a canonical UUID',
    );
  }
  return {
    leaseId: snapshot.workspaceLeaseId as WorkspaceLeaseId,
    environmentId: snapshot.environmentId as EnvironmentId,
    ownerAgentRunId,
    access: 'exclusive_write',
    status: 'active',
    rootRef: root,
    acquiredAt: new Date().toISOString(),
    cleanupPolicy: 'retain',
    fencingEpoch: snapshot.workspaceFencingEpoch ?? 0,
    version: snapshot.workspaceLeaseVersion ?? 0,
  };
}

function normalizedAbsolute(path: string): string {
  return normalize(isAbsolute(path) ? path : resolve(path));
}

function samePhysicalPath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
}

function pathInside(candidate: string, root: string): boolean {
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
function canonicalHostPath(rawPath: string, root: string): {
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

function filesystemRoots(
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

function rootForPath(
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

function resourceMatches(
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
          candidate === normalizedAbsolute(resource.root)
          || pathInside(normalizedAbsolute(resource.root), candidate));
      }
      return paths.some((resource) => candidate === normalizedAbsolute(resource.root));
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
    case 'control':
      return true;
  }
}

function derivedFilesystemEffectMatches(
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
    && (effect.operation === 'mkdir' || effect.operation === 'writeFile')) {
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
      return new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+\\.md$`)
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

class MutationFenceAuthority implements ToolMutationFence {
  readonly signal: AbortSignal;
  readonly resourceBinding = undefined;
  private readonly abortController = new AbortController();
  private monitor: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: MutationFenceAuthorityOptions) {
    this.signal = this.abortController.signal;
  }

  get mode(): 'shadow' | 'enforce' {
    return this.options.mode;
  }

  bindInvocation(input: {
    toolName: string;
    toolUseId: string;
    effectiveInput: Record<string, unknown>;
    boundary?: ToolEffectBoundaryKind;
    requiresEffectBoundary: boolean;
  }): ToolMutationFence {
    let binding: ResourceBinding | undefined;
    try {
      this.options.assertLease();
      if (input.requiresEffectBoundary && !input.boundary) {
        throw new MutationFenceError(
          'unsupported_capability',
          `${input.toolName} has no declared physical effect boundary`,
        );
      }
      if (input.boundary) {
        const resources = resourcesForInvocation(
          input.boundary,
          input.toolName,
          input.effectiveInput,
        );
        if (input.requiresEffectBoundary
          && input.boundary !== 'nested'
          && input.boundary !== 'control'
          && resources.length === 0) {
          throw new MutationFenceError(
            'resource_binding_required',
            `${input.toolName} did not resolve a canonical ${input.boundary} resource`,
          );
        }
        const snapshot = this.options.snapshot();
        const bindingId =
          `effect:${snapshot.workspaceLeaseId ?? snapshot.environmentId}:${input.toolUseId}`;
        const resolvedAt = new Date().toISOString();
        const common = {
          bindingId,
          effectiveInput: input.effectiveInput,
          ttlMs: this.options.bindingTtlMs ?? 5 * 60_000,
          resolvedAt,
        };
        const environment = environmentFor(snapshot, this.options.authorizedRoot);
        const lease = leaseFor(snapshot, this.options.authorizedRoot);
        const pathResources = resources.filter((resource) => resource.kind === 'path');
        const nonPathResources = resources.filter((resource) => resource.kind !== 'path');
        const parts: ResourceBinding[] = [];
        if (nonPathResources.length > 0 || resources.length === 0) {
          parts.push(bindResource({
            ...common,
            resources: nonPathResources,
            authorizedRoot: this.options.authorizedRoot,
          }, environment, lease));
        }
        for (const resource of pathResources) {
          const selected = rootForPath(
            this.options,
            input.effectiveInput,
            resource.path ?? '',
          );
          const canonical = canonicalHostPath(selected.pathWithinRoot, selected.rootPath);
          parts.push(bindResource({
            ...common,
            resources: [{ ...resource, path: canonical.candidate }],
            authorizedRoot: canonical.root,
          }, environment, lease));
        }
        const [first, ...rest] = parts;
        if (first) {
          binding = {
            ...first,
            canonicalResources: [
              ...first.canonicalResources,
              ...rest.flatMap((part) => part.canonicalResources),
            ],
          };
        }
      }
    } catch (error) {
      this.violation(error);
    }
    return new BoundMutationFence(this, input, binding);
  }

  assertMutation(_effect: ToolMutationEffect): void {
    this.violation(new MutationFenceError(
      'unbound_invocation',
      'effect reached the base fence without an invocation binding',
    ));
  }

  assertBound(
    invocation: {
      effectiveInput: Record<string, unknown>;
      boundary?: ToolEffectBoundaryKind;
      toolName: string;
    },
    binding: ResourceBinding | undefined,
    effect: ToolMutationEffect,
  ): void {
    try {
      this.options.assertLease();
      if (!invocation.boundary || !binding) {
        throw new MutationFenceError(
          'resource_binding_required',
          `${invocation.toolName} reached ${effect.kind} without a sealed binding`,
        );
      }
      if (invocation.boundary !== effect.kind) {
        throw new MutationFenceError(
          'boundary_mismatch',
          `${invocation.toolName} declared ${invocation.boundary} but reached ${effect.kind}`,
        );
      }
      if (sha256(invocation.effectiveInput) !== binding.effectiveInputHash) {
        throw new MutationFenceError(
          'effective_input_changed',
          `${invocation.toolName} input changed after policy/binding resolution`,
        );
      }
      const snapshot = this.options.snapshot();
      const revalidated = revalidateBinding(binding, {
        environmentVersion: snapshot.environmentVersion,
        workspaceLeaseVersion: snapshot.workspaceLeaseVersion,
        workspaceFencingEpoch: snapshot.workspaceFencingEpoch,
      });
      if (!revalidated.ok) {
        throw new MutationFenceError(
          revalidated.reasonCode,
          `${invocation.toolName} execution environment/lease changed`,
        );
      }
      let physicalEffect = effect;
      if (effect.kind === 'filesystem' && effect.resource) {
        const selected = rootForPath(
          this.options,
          invocation.effectiveInput,
          effect.resource,
        );
        const canonical = canonicalHostPath(selected.pathWithinRoot, selected.rootPath);
        physicalEffect = { ...effect, resource: canonical.candidate };
      }
      if (!resourceMatches(binding, physicalEffect)
        && !derivedFilesystemEffectMatches(
          this.options,
          invocation,
          binding,
          physicalEffect,
        )) {
        throw new MutationFenceError(
          'resource_mismatch',
          `${invocation.toolName} attempted an unbound ${effect.kind} resource`,
        );
      }
      if (physicalEffect.kind === 'filesystem' && physicalEffect.resource) {
        const candidate = normalizedAbsolute(physicalEffect.resource);
        const delegated = filesystemRoots(this.options).some((root) => {
          if (root.access !== 'write') return false;
          try {
            const canonicalRoot = canonicalHostPath(root.rootPath, root.rootPath).root;
            return pathInside(candidate, canonicalRoot);
          } catch {
            return false;
          }
        });
        if (!delegated) {
          throw new MutationFenceError(
            'path_escape',
            `${invocation.toolName} attempted an effect outside delegated writable roots`,
          );
        }
      }
      // Final synchronous ownership check. First-party ports perform no await
      // between this return and the physical syscall/spawn/request dispatch.
      this.options.assertLease();
    } catch (error) {
      this.violation(error);
    }
  }

  startLeaseMonitor(): () => void {
    if (this.monitor || this.options.mode !== 'enforce') return () => this.stopMonitor();
    const interval = Math.max(50, this.options.pollMs ?? 1_000);
    this.monitor = setInterval(() => {
      try {
        this.options.assertLease();
      } catch (error) {
        try {
          this.violation(error);
        } catch {
          // The monitor communicates enforcement through the shared abort
          // signal. Never throw from a timer callback into the process.
        } finally {
          this.stopMonitor();
        }
      }
    }, interval);
    this.monitor.unref?.();
    return () => this.stopMonitor();
  }

  private stopMonitor(): void {
    if (!this.monitor) return;
    clearInterval(this.monitor);
    this.monitor = null;
  }

  private violation(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.options.onViolation?.(normalized);
    if (this.options.mode !== 'enforce') return;
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(normalized);
    }
    throw normalized;
  }
}

class BoundMutationFence implements ToolMutationFence {
  constructor(
    private readonly authority: MutationFenceAuthority,
    private readonly invocation: {
      toolName: string;
      toolUseId: string;
      effectiveInput: Record<string, unknown>;
      boundary?: ToolEffectBoundaryKind;
      requiresEffectBoundary: boolean;
    },
    readonly resourceBinding?: ResourceBinding,
  ) {}

  get mode(): 'shadow' | 'enforce' {
    return this.authority.mode;
  }

  get signal(): AbortSignal | undefined {
    return this.authority.signal;
  }

  bindInvocation(input: {
    toolName: string;
    toolUseId: string;
    effectiveInput: Record<string, unknown>;
    boundary?: ToolEffectBoundaryKind;
    requiresEffectBoundary: boolean;
  }): ToolMutationFence {
    return this.authority.bindInvocation(input);
  }

  assertMutation(effect: ToolMutationEffect): void {
    this.authority.assertBound(this.invocation, this.resourceBinding, effect);
  }

  startLeaseMonitor(): () => void {
    return this.authority.startLeaseMonitor();
  }
}

export function createMutationFenceAuthority(
  options: MutationFenceAuthorityOptions,
): ToolMutationFence {
  return new MutationFenceAuthority(options);
}

export function combinedMutationSignal(
  signal: AbortSignal | undefined,
  fence: ToolMutationFence | undefined,
): AbortSignal | undefined {
  const signals = [signal, fence?.signal].filter(
    (candidate): candidate is AbortSignal => !!candidate,
  );
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

export function assertMutationFence(
  fence: ToolMutationFence | undefined,
  effect: ToolMutationEffect,
): void {
  fence?.assertMutation(effect);
}
