import type { MutationFenceSnapshot, MutationFenceAuthorityOptions } from './mutation-fence-types.js';
export type { MutationFenceSnapshot, MutationFenceAuthorityOptions } from './mutation-fence-types.js';
import { MutationFenceError, resourcesForInvocation, normalizedAbsolute, pathInside, canonicalHostPath, filesystemRoots, rootForPath, resourceMatches, derivedFilesystemEffectMatches } from './mutation-fence-resources.js';
export { MutationFenceError } from './mutation-fence-resources.js';
import { createHash } from 'node:crypto';

import { asAgentRunId, type AgentRunId, type EnvironmentId, type ExecutionEnvironmentRef, type ResourceBinding, type WorkspaceLease, type WorkspaceLeaseId } from '@mcp/agent-runtime-contracts';
import { bindResource, revalidateBinding } from './resource-binding.js';
import type { ToolEffectBoundaryKind, ToolMutationEffect, ToolMutationFence } from './tool.js';

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
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
      this.options.assertLease(input);
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
      this.options.assertLease(invocation);
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
      this.options.assertLease(invocation);
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
