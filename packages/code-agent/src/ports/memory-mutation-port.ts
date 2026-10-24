import type { ResourceBinding } from '@mcp/agent-runtime-contracts';

export type MemoryMutationTool = 'remember' | 'forget_memory' | 'mcp__save_memory';
export interface MemoryMutationCall {
  toolName: MemoryMutationTool;
  input: Record<string, unknown>;
  toolUseId?: string;
  binding?: ResourceBinding;
  signal?: AbortSignal;
}
export type MemoryMutationResult = { created: number; merged: number; skipped: number } | { archived: number } | null;
export interface MemoryMutationPort {
  invoke(call: MemoryMutationCall): Promise<MemoryMutationResult>;
}
