import { clone } from '@bufbuild/protobuf';
import {
  agentV1Common,
  type agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import type { AgentHelloSelection } from './HostLaunchValidation.js';

export interface AcceptedAgentHello {
  readonly supportedProtocols: AgentHelloSelection['supportedProtocols'];
  readonly provenance?: agentV1Common.RuntimeProvenance;
  readonly containment?: agentV1Common.ContainmentCapabilities;
  readonly supportedFeatureBits: bigint;
  readonly nativeCapabilities:
    readonly agentV1Common.NativeCapabilityProvenance[];
}

export function summarizeAgentHello(
  hello: agentV1Runtime.AgentHello,
  selection: AgentHelloSelection,
): AcceptedAgentHello {
  return Object.freeze({
    supportedProtocols: Object.freeze({ ...selection.supportedProtocols }),
    provenance: hello.provenance
      ? clone(agentV1Common.RuntimeProvenanceSchema, hello.provenance)
      : undefined,
    containment: hello.containment
      ? clone(agentV1Common.ContainmentCapabilitiesSchema, hello.containment)
      : undefined,
    supportedFeatureBits: hello.supportedFeatureBits,
    nativeCapabilities: Object.freeze(hello.nativeCapabilities.map(
      (capability) => clone(
        agentV1Common.NativeCapabilityProvenanceSchema,
        capability,
      ),
    )),
  });
}
