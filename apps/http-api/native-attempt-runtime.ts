import { createHash, randomBytes } from 'node:crypto';
import { fromBinary } from '@bufbuild/protobuf';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { nativePrepareAttempt, provisionNativeAttempt, type NativeAttemptProvisioningInput } from '@mcp/agent-runtime-host';
import type { ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import type { FileControlPlaneAuthority } from './file-control-plane-store.js';

export type NativeProductAuthority = Pick<FileControlPlaneAuthority,
  'admitNativeAttempt' | 'createNativeActivationPort' | 'createSupervisorFactPort' | 'getAttemptState'
  | 'getRuntimeRoute' | 'commitRuntimeRoute' | 'commitRuntimeRequest' | 'terminalizeRun' | 'admitNativeChild'>;

export type NativeProductAttemptInput = Omit<NativeAttemptProvisioningInput,
  'leaseExpiresAtUnixMs' | 'activationAuthoritySeal' | 'durability' | 'durableFacts'> & {
  readonly store: NativeProductAuthority;
  readonly context: ControlPlaneRunContext;
};

/** Product-owned admission and physical provisioning. Runtime routing remains
 * committed by the facade before launch; activation refuses a missing route. */
export async function admitNativeProductAttempt(input: NativeProductAttemptInput) {
  const prepare = nativePrepareAttempt(input.spec);
  const spec = fromBinary(agentV1Runtime.ResolvedAttemptSpecSchema, prepare.encodedSpec);
  const context = { ...input.context };
  const nonce = Uint8Array.from(randomBytes(32));
  try {
    const admission = await input.store.admitNativeAttempt(context, {
      prepare, activationNonceSha256: createHash('sha256').update(nonce).digest(),
      requiredContainmentLevel: input.requiredContainmentLevel, requiredEnforcedLimits: input.requiredEnforcedLimits,
    });
    const durability = input.store.createNativeActivationPort(context, nonce);
    let provisioned = false;
    return { prepare, admission, async provision() {
      if (provisioned) throw new Error('Native physical launch was already provisioned');
      provisioned = true;
      // Routing and cold module loading may be slow. Mint physical launch
      // authority only after those steps, using the current executor lease.
      const state = await input.store.getAttemptState(context);
      return provisionNativeAttempt({ ...input, spec,
        leaseExpiresAtUnixMs: BigInt(Date.parse(state.attempt.executorLease.expiresAt)),
        activationAuthoritySeal: admission.activationAuthoritySeal, durability,
        durableFacts: (connectionId) => input.store.createSupervisorFactPort(context, connectionId),
      });
    } };
  } finally { nonce.fill(0); }
}

/** Immediate physical provisioning for callers that already loaded the runtime. */
export async function prepareNativeProductAttempt(input: NativeProductAttemptInput) {
  const admitted = await admitNativeProductAttempt(input);
  return { prepare: admitted.prepare, admission: admitted.admission, options: await admitted.provision() };
}
