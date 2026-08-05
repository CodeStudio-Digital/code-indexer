import type {
  agentV1Artifact,
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import type { ChatProvider } from '@mcp/provider-sdk/adapter.js';

export interface ProviderGatewayLimits {
  maxActiveOperations: number;
  maxOperationMs: number;
  maxRequestBytes: number;
  maxArtifactBytes: number;
  maxMessages: number;
  maxContentBlocks: number;
  maxTools: number;
  maxToolSchemaBytes: number;
  maxToolArgumentsBytes: number;
  maxBufferedToolCalls: number;
  maxStreamEvents: number;
  maxEventBytes: number;
}

export const DEFAULT_PROVIDER_GATEWAY_LIMITS: ProviderGatewayLimits = {
  maxActiveOperations: 32,
  maxOperationMs: 30 * 60_000,
  maxRequestBytes: 8 * 1024 * 1024,
  maxArtifactBytes: 4 * 1024 * 1024,
  maxMessages: 2_048,
  maxContentBlocks: 8_192,
  maxTools: 512,
  maxToolSchemaBytes: 256 * 1024,
  maxToolArgumentsBytes: 1024 * 1024,
  maxBufferedToolCalls: 32,
  maxStreamEvents: 100_000,
  maxEventBytes: 1024 * 1024,
};

export interface ProviderResolverPort {
  resolve(
    binding: agentV1Runtime.ProviderBinding,
    signal: AbortSignal,
  ): ChatProvider | Promise<ChatProvider>;
}

export interface ProviderArtifactReaderPort {
  read(
    artifact: agentV1Artifact.ArtifactRef,
    maximumBytes: number,
    signal: AbortSignal,
  ): Uint8Array | Promise<Uint8Array>;
}

export type ProviderGatewayEvent =
  | { case: 'providerAccepted'; value: agentV1Runtime.ProviderAccepted }
  | { case: 'providerTextDelta'; value: agentV1Runtime.ProviderTextDelta }
  | { case: 'providerThinkingDelta'; value: agentV1Runtime.ProviderThinkingDelta }
  | { case: 'providerToolCall'; value: agentV1Runtime.ProviderToolCall }
  | { case: 'providerUsage'; value: agentV1Runtime.ProviderUsageEvent }
  | { case: 'providerTerminal'; value: agentV1Runtime.ProviderTerminal };

export interface ProviderGatewayEventSinkPort {
  emit(event: ProviderGatewayEvent): void | Promise<void>;
}

export interface ProviderGatewayDependencies {
  runtimeInstanceId: string;
  resolver: ProviderResolverPort;
  artifactReader?: ProviderArtifactReaderPort;
  limits?: Partial<ProviderGatewayLimits>;
  now?: () => number;
}

export interface ProviderOperationAuthority {
  identity: agentV1Common.AttemptIdentity;
  operationId: string;
}
