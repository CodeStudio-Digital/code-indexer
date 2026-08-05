import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { create, toBinary } from '@bufbuild/protobuf';
import { agentV1Capability } from '@mcp/agent-runtime-contracts';
import type { AuthorityClock } from '../ipc/AttemptClock.js';
import type { HostDataBoundContext } from '../ipc/HostDataAttemptChannelValidation.js';
import { CapabilityGateway } from './CapabilityGateway.js';
import type {
  CapabilityDecisionResolver,
  CapabilityResolution,
  ValidatedCapabilityPrepare,
} from './CapabilityGatewayTypes.js';
import type { NativeReadCapabilityPolicyOptions } from './NativeReadCapabilityPolicyTypes.js';

const CAPABILITY_ID = 'native.read_file';
const CAPABILITY_VERSION = '1';
const MAX_NATIVE_READ_BYTES = 64n * 1024n * 1024n;
const MAX_GRANT_TTL_MS = 5n * 60n * 1_000n;

export type NativeReadCapabilityGatewayFactory = (
  context: HostDataBoundContext,
  clock: AuthorityClock,
) => CapabilityGateway;

/**
 * Builds one fail-closed resolver per physical attempt. The caller supplies
 * product authority; provider/tool input can only select a path below root.
 */
export function createNativeReadCapabilityGatewayFactory(
  options: NativeReadCapabilityPolicyOptions,
): NativeReadCapabilityGatewayFactory {
  const authority = validateOptions(options);
  let canonicalRoot: Promise<string> | undefined;
  return (context, clock) => new CapabilityGateway(
    context,
    new NativeReadCapabilityPolicy(
      authority,
      clock,
      () => canonicalRoot ??= canonicalDirectory(authority.rootPath),
    ),
    () => clock.now(),
  );
}

class NativeReadCapabilityPolicy implements CapabilityDecisionResolver {
  constructor(
    private readonly authority: Readonly<NativeReadCapabilityPolicyOptions>,
    private readonly clock: AuthorityClock,
    private readonly canonicalRoot: () => Promise<string>,
  ) {}

  async resolve(request: ValidatedCapabilityPrepare): Promise<CapabilityResolution> {
    if (!authorizedInvocation(request, this.authority.capabilitySetSha256)) {
      return this.reject('native_read_not_authorized');
    }
    let root: string;
    try {
      root = await this.canonicalRoot();
    } catch {
      return this.reject('native_read_root_unavailable');
    }
    const now = this.clock.now();
    if (now >= request.deadlineAtUnixMs) {
      return this.reject('native_read_deadline_elapsed', now);
    }
    const binding = create(
      agentV1Capability.NativeFilesystemReadBindingSchema,
      {
        canonicalRootPath: root,
        maxReadBytes: this.authority.maxReadBytes,
        maxOutputBytes: this.authority.maxOutputBytes,
        requireUtf8: this.authority.requireUtf8,
      },
    );
    const lease = this.authority.workspaceLease;
    return {
      case: 'accepted',
      value: create(agentV1Capability.SealedExecutionGrantSchema, {
        grantId: `grant/${randomUUID()}`,
        decisionId: `decision/${randomUUID()}`,
        capabilityId: request.capabilityId,
        capabilityVersion: request.capabilityVersion,
        operationId: request.operationId,
        toolUseId: request.toolUseId,
        effectiveInputSha256: request.inputSha256,
        executionClass: request.executionClass,
        mutates: request.mutates,
        environmentId: this.authority.environmentId,
        environmentVersion: this.authority.environmentVersion,
        workspaceLeaseId: lease?.id,
        workspaceLeaseVersion: lease?.version,
        workspaceFencingEpoch: lease?.fencingEpoch,
        resourceBindingId: this.authority.resourceBindingId,
        constraintsSha256: digest(toBinary(
          agentV1Capability.NativeFilesystemReadBindingSchema,
          binding,
        )),
        policyVersion: this.authority.policyVersion,
        nonce: randomBytes(32),
        issuedAtUnixMs: now,
        expiresAtUnixMs: min(
          now + this.authority.grantTtlMs,
          request.deadlineAtUnixMs,
        ),
        nativeFilesystemRead: binding,
      }),
    };
  }

  private reject(reasonCode: string, now = this.clock.now()): CapabilityResolution {
    return {
      case: 'rejected',
      value: create(agentV1Capability.CapabilityRejectedSchema, {
        decisionId: `decision/${randomUUID()}`,
        reasonCode,
        policyVersion: this.authority.policyVersion,
        decidedAtUnixMs: now,
      }),
    };
  }
}

function validateOptions(
  options: NativeReadCapabilityPolicyOptions,
): Readonly<NativeReadCapabilityPolicyOptions> {
  const lease = options.workspaceLease;
  if (
    !isAbsolute(options.rootPath)
    || normalize(options.rootPath) !== options.rootPath
    || options.rootPath.includes('\0')
    || options.capabilitySetSha256.byteLength !== 32
    || !idsValid([
      options.environmentId,
      options.resourceBindingId,
      options.policyVersion,
      ...(lease ? [lease.id] : []),
    ])
    || options.environmentVersion <= 0n
    || options.grantTtlMs <= 0n
    || options.grantTtlMs > MAX_GRANT_TTL_MS
    || options.maxReadBytes <= 0n
    || options.maxReadBytes > MAX_NATIVE_READ_BYTES
    || options.maxOutputBytes <= 0n
    || options.maxOutputBytes > MAX_NATIVE_READ_BYTES
    || (lease !== undefined && (
      lease.version <= 0n || lease.fencingEpoch <= 0n
    ))
  ) throw new RangeError('native read capability policy authority');
  return Object.freeze({
    ...options,
    capabilitySetSha256: options.capabilitySetSha256.slice(),
    workspaceLease: lease && Object.freeze({ ...lease }),
  });
}

function authorizedInvocation(
  request: ValidatedCapabilityPrepare,
  capabilitySetSha256: Uint8Array,
): boolean {
  return request.capabilityId === CAPABILITY_ID
    && request.capabilityVersion === CAPABILITY_VERSION
    && request.executionClass
      === agentV1Capability.CapabilityExecutionClass.NATIVE_READ
    && !request.mutates
    && timingSafeEqual(request.capabilitySetSha256, capabilitySetSha256);
}

async function canonicalDirectory(rootPath: string): Promise<string> {
  const canonical = normalize(await realpath(rootPath));
  if (!isAbsolute(canonical) || !(await stat(canonical)).isDirectory()) {
    throw new Error('native read root is not a canonical directory');
  }
  return canonical;
}

function idsValid(values: readonly string[]): boolean {
  return values.every((value) => value.length > 0
    && value.length <= 1_024
    && !value.includes('\0'));
}

function digest(value: Uint8Array): Uint8Array {
  return createHash('sha256').update(value).digest();
}

function min(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}
