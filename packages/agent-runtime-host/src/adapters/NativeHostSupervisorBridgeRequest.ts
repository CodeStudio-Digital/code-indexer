import { randomUUID } from 'node:crypto';
import {
  create,
  toBinary,
} from '@bufbuild/protobuf';
import {
  agentV1SupervisorBootstrap,
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';
import type {
  HostSupervisorBootstrapProvision,
} from '../ipc/HostSupervisorBootstrapTypes.js';
import {
  expectedProvenanceEqual,
  validateHostSupervisorProvision,
} from '../ipc/HostSupervisorProvisionValidation.js';
import type {
  VerifiedRuntimePackage,
  VerifiedRuntimeBinary,
} from '../packaging/RuntimePackageTypes.js';

declare const NATIVE_SUPERVISOR_REQUEST_BRAND: unique symbol;

export interface NativeHostSupervisorBridgeOpenRequestOwner {
  readonly [NATIVE_SUPERVISOR_REQUEST_BRAND]: true;
}

export interface NativeHostSupervisorBridgeOpenRequestInput {
  readonly runtimePackage: VerifiedRuntimePackage;
  readonly provision: HostSupervisorBootstrapProvision;
  readonly lifecycleOutboxDirectory?: string;
}

class NativeSupervisorRequestOwner
implements NativeHostSupervisorBridgeOpenRequestOwner {
  declare readonly [NATIVE_SUPERVISOR_REQUEST_BRAND]: true;
}

const requests = new WeakMap<object, Uint8Array>();
const abandonedRequestScrubber = new FinalizationRegistry<Uint8Array>(
  (encoded) => encoded.fill(0),
);

export function encodeNativeHostSupervisorBridgeOpenRequest(
  input: NativeHostSupervisorBridgeOpenRequestInput,
): NativeHostSupervisorBridgeOpenRequestOwner {
  const validated = validateHostSupervisorProvision(input.provision);
  let request:
    agentV1SupervisorBootstrap.HostSupervisorBridgeOpenRequest | undefined;
  try {
    const supervisor = expectedProvenance(
      input.runtimePackage,
      input.runtimePackage.binaries.supervisor,
    );
    const runner = expectedProvenance(
      input.runtimePackage,
      input.runtimePackage.binaries.runner,
    );
    if (
      !expectedProvenanceEqual(
        validated.policy.expectedSupervisorProvenance,
        supervisor,
      )
      || !validated.policy.allowedRunnerProvenance.some(
        (candidate) => expectedProvenanceEqual(candidate, runner),
      )
    ) throw new TypeError('runtime package provenance is outside Host policy');
    const selectedProtocol = input.provision.hostHello.selectedProtocol;
    if (!selectedProtocol) throw new TypeError('selected protocol is absent');
    request = create(
      agentV1SupervisorBootstrap.HostSupervisorBridgeOpenRequestSchema,
      {
        schemaVersion: 1,
        managementEndpointName: `management-${randomUUID()}`,
        managementConnectionId: input.provision.expectedConnectionId,
        managementSessionToken: Uint8Array.from(
          input.provision.expectedManagementSessionToken,
        ),
        supervisorLaunchNonce: Uint8Array.from(
          input.provision.expectedSupervisorLaunchNonce,
        ),
        trustedSupervisorProvenance: supervisor,
        trustedRunnerProvenance: runner,
        selectedProtocol: {
          major: selectedProtocol.major,
          minor: selectedProtocol.minor,
        },
        supervisorExecutable:
          input.runtimePackage.binaries.supervisor.absolutePath,
        runnerExecutable: input.runtimePackage.binaries.runner.absolutePath,
        startupTimeoutMs: 10_000n,
        lifecycleOutboxDirectory: input.lifecycleOutboxDirectory ?? '',
      },
    );
    const encoded = toBinary(
      agentV1SupervisorBootstrap.HostSupervisorBridgeOpenRequestSchema,
      request,
    );
    const owner = Object.freeze(new NativeSupervisorRequestOwner());
    requests.set(owner, encoded);
    abandonedRequestScrubber.register(owner, encoded, owner);
    return owner;
  } finally {
    request?.managementSessionToken.fill(0);
    request?.supervisorLaunchNonce.fill(0);
    validated.hello.managementSessionToken.fill(0);
    validated.managementTokenDigest.fill(0);
    validated.supervisorNonceDigest.fill(0);
  }
}

export async function useNativeHostSupervisorBridgeOpenRequest<T>(
  owner: NativeHostSupervisorBridgeOpenRequestOwner,
  invoke: (encoded: Uint8Array) => T | Promise<T>,
): Promise<T> {
  const encoded = requests.get(owner);
  if (!encoded) {
    throw new TypeError(
      'native Host supervisor request was consumed or foreign',
    );
  }
  requests.delete(owner);
  abandonedRequestScrubber.unregister(owner);
  try {
    return await invoke(encoded);
  } finally {
    encoded.fill(0);
  }
}

export function abortNativeHostSupervisorBridgeOpenRequest(
  owner: NativeHostSupervisorBridgeOpenRequestOwner,
): void {
  const encoded = requests.get(owner);
  if (!encoded) return;
  requests.delete(owner);
  abandonedRequestScrubber.unregister(owner);
  encoded.fill(0);
}

function expectedProvenance(
  runtimePackage: VerifiedRuntimePackage,
  binary: VerifiedRuntimeBinary,
): agentV1Supervisor.ExpectedRuntimeProvenance {
  return create(agentV1Supervisor.ExpectedRuntimeProvenanceSchema, {
    buildId: runtimePackage.manifest.buildId,
    sourceCommit: runtimePackage.manifest.sourceCommit,
    binarySha256: hexBytes(binary.sha256),
    operatingSystem: runtimePackage.manifest.operatingSystem,
    architecture: runtimePackage.manifest.architecture,
  });
}

function hexBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError('runtime package binary digest is invalid');
  }
  return Uint8Array.from(Buffer.from(value, 'hex'));
}
