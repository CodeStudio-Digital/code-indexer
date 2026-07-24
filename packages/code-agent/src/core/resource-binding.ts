/**
 * Resource binding + revalidation (Fase 2 — 2C).
 *
 * Turns a tool invocation's declared resources into a short-lived, versioned
 * `ResourceBinding` WITHOUT executing any effect. Paths are canonicalized and
 * confined to the authorized root (traversal / symlink escape fails closed);
 * command / network / database / secret resources are classified into the
 * discriminated `ResourceConstraint` union.
 *
 * `revalidateBinding` is called immediately before the side effect: if the
 * environment version, lease version or fencing epoch moved since the binding
 * was resolved (or the binding expired), it fails closed so a stale approval
 * can never execute against a changed world.
 */
import { createHash } from 'node:crypto';
import { resolve, isAbsolute, normalize, sep } from 'node:path';
import type {
  ExecutionEnvironmentRef,
  ResourceBinding,
  ResourceConstraint,
  WorkspaceLease,
} from '@mcp/agent-runtime-contracts';

export interface ResourceBindingInputResource {
  kind: ResourceConstraint['kind'];
  /** Raw, un-canonicalized path (for kind 'path'). */
  path?: string;
  access?: 'read' | 'write';
  followSymlinks?: boolean;
  /** For kind 'command'. */
  executable?: string;
  argRules?: string[];
  /** For kind 'network'. */
  domains?: string[];
  methods?: string[];
  /** For kind 'database'. */
  databaseId?: string;
  operations?: string[];
  /** For kind 'secret'. */
  secretIds?: string[];
  exposure?: 'handle-only' | 'environment';
  /** For kind 'application'. */
  appId?: string;
}

export interface BindResourceInput {
  bindingId: string;
  /** The effective (already patch-applied) tool input; hashed, never stored raw. */
  effectiveInput: unknown;
  resources: ResourceBindingInputResource[];
  /** Absolute authorized root the paths must stay within. */
  authorizedRoot: string;
  ttlMs?: number;
  resolvedAt?: string;
}

export class ResourceBindingError extends Error {
  constructor(readonly reasonCode: string, detail: string) {
    super(`resource-binding ${reasonCode}: ${detail}`);
    this.name = 'ResourceBindingError';
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Canonicalizes and confines a path to the authorized root. Rejects traversal
 * and any candidate that resolves outside the root. Purely lexical — no disk
 * access — so it is deterministic and safe to run before any effect.
 */
export function confinePath(rawPath: string, authorizedRoot: string): string {
  const root = resolve(authorizedRoot);
  const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  const rootWithSep = normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep;
  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(rootWithSep)) {
    throw new ResourceBindingError('path_escape', `${rawPath} resolves outside ${authorizedRoot}`);
  }
  return normalizedCandidate;
}

function classifyResource(
  resource: ResourceBindingInputResource,
  authorizedRoot: string,
): ResourceConstraint {
  switch (resource.kind) {
    case 'path': {
      if (!resource.path) throw new ResourceBindingError('missing_path', 'path resource has no path');
      return {
        kind: 'path',
        root: confinePath(resource.path, authorizedRoot),
        access: resource.access === 'write' ? 'write' : 'read',
        followSymlinks: resource.followSymlinks ?? false,
      };
    }
    case 'command':
      if (!resource.executable) throw new ResourceBindingError('missing_executable', 'command resource has no executable');
      return { kind: 'command', executable: resource.executable, ...(resource.argRules ? { argRules: resource.argRules } : {}) };
    case 'network':
      return { kind: 'network', domains: resource.domains ?? [], ...(resource.methods ? { methods: resource.methods } : {}) };
    case 'database':
      if (!resource.databaseId) throw new ResourceBindingError('missing_database', 'database resource has no databaseId');
      return { kind: 'database', databaseId: resource.databaseId, operations: resource.operations ?? [] };
    case 'secret':
      return { kind: 'secret', secretIds: resource.secretIds ?? [], exposure: resource.exposure ?? 'handle-only' };
    case 'application':
      if (!resource.appId) throw new ResourceBindingError('missing_app', 'application resource has no appId');
      return { kind: 'application', appId: resource.appId, operations: resource.operations ?? [] };
    case 'workspace_lease':
      throw new ResourceBindingError('unsupported', 'workspace_lease is derived from the lease, not declared input');
    default:
      throw new ResourceBindingError('unknown_kind', `unknown resource kind ${(resource as { kind: string }).kind}`);
  }
}

export function bindResource(
  input: BindResourceInput,
  environment: ExecutionEnvironmentRef,
  lease?: WorkspaceLease,
): ResourceBinding {
  const resolvedAt = input.resolvedAt ?? new Date().toISOString();
  const ttlMs = input.ttlMs ?? 30_000;
  const canonicalResources = input.resources.map((r) => classifyResource(r, input.authorizedRoot));
  const effectiveInputHash = sha256Hex(JSON.stringify(input.effectiveInput ?? null));
  const canonicalInputRef = `binding-input:${effectiveInputHash}`;

  return {
    bindingId: input.bindingId,
    effectiveInputHash,
    canonicalInputRef,
    canonicalResources,
    environmentId: environment.environmentId,
    environmentVersion: environment.version,
    ...(lease ? {
      workspaceLeaseId: lease.leaseId,
      workspaceLeaseVersion: lease.version,
      workspaceFencingEpoch: lease.fencingEpoch,
    } : {}),
    resolvedAt,
    expiresAt: new Date(Date.parse(resolvedAt) + ttlMs).toISOString(),
  };
}

export interface RevalidationContext {
  environmentVersion: number;
  workspaceLeaseVersion?: number;
  workspaceFencingEpoch?: number;
  now?: string;
}

export type RevalidationResult =
  | { ok: true }
  | { ok: false; reasonCode: 'expired' | 'environment_changed' | 'lease_changed' | 'epoch_changed' };

/**
 * Fails closed when the world moved since the binding was resolved. This is
 * the last gate immediately before the side effect.
 */
export function revalidateBinding(
  binding: ResourceBinding,
  context: RevalidationContext,
): RevalidationResult {
  const now = context.now ?? new Date().toISOString();
  if (Date.parse(binding.expiresAt) <= Date.parse(now)) {
    return { ok: false, reasonCode: 'expired' };
  }
  if (binding.environmentVersion !== context.environmentVersion) {
    return { ok: false, reasonCode: 'environment_changed' };
  }
  if (binding.workspaceLeaseVersion !== undefined
    && binding.workspaceLeaseVersion !== context.workspaceLeaseVersion) {
    return { ok: false, reasonCode: 'lease_changed' };
  }
  if (binding.workspaceFencingEpoch !== undefined
    && binding.workspaceFencingEpoch !== context.workspaceFencingEpoch) {
    return { ok: false, reasonCode: 'epoch_changed' };
  }
  return { ok: true };
}
