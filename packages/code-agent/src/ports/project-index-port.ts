import type { ResourceBinding } from '@mcp/agent-runtime-contracts';

export interface ProjectIndexPort {
  invoke(call: { input: Record<string, unknown>; toolUseId?: string; binding?: ResourceBinding; signal?: AbortSignal }): Promise<string>;
}
