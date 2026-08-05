import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import type { AgentMessage } from '@mcp/provider-sdk/wire.js';
import { ProviderGatewayError } from './ProviderGatewayError.js';

export function roleFromWire(
  role: agentV1Runtime.ProviderMessageRole,
): AgentMessage['role'] {
  if (role === agentV1Runtime.ProviderMessageRole.USER) return 'user';
  if (role === agentV1Runtime.ProviderMessageRole.ASSISTANT) return 'assistant';
  if (role === agentV1Runtime.ProviderMessageRole.TOOL) return 'tool';
  throw invalid('provider message role is unspecified');
}

export function phaseFromWire(
  phase: agentV1Runtime.ProviderMessagePhase,
): AgentMessage['phase'] {
  if (phase === agentV1Runtime.ProviderMessagePhase.COMMENTARY) return 'commentary';
  if (phase === agentV1Runtime.ProviderMessagePhase.FINAL_ANSWER) return 'final_answer';
  if (phase === agentV1Runtime.ProviderMessagePhase.UNSPECIFIED) return undefined;
  throw invalid('provider message phase is unknown');
}

export function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith('text/') || /(?:json|xml|yaml|javascript)$/.test(mediaType);
}

function invalid(message: string): ProviderGatewayError {
  return new ProviderGatewayError('invalid_provider_request', message);
}
