import type { LspServerStatus } from '@mcp/api-bus';

interface LspRuntimeGate {
  kind: 'node' | 'java' | 'dotnet';
  label: string;
  reason?: string;
}

export function lspRuntimeGate(status: LspServerStatus): LspRuntimeGate | null {
  if (status.nodeRuntime?.satisfied === false) {
    return {
      kind: 'node',
      label: `Node ${status.nodeRuntime.range}`,
      reason: status.nodeRuntime.reason,
    };
  }
  const runtime = status.runtime;
  if (!runtime || runtime.satisfied) return null;
  return {
    kind: runtime.kind,
    label: runtime.kind === 'java' ? `JDK ${runtime.minMajor}+` : `.NET SDK ${runtime.minMajor}+`,
    reason: runtime.reason,
  };
}
