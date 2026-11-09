export interface ToolProjectionReceipt {
  discovery: import('@mcp/agent-runtime-contracts').DiscoveryReceipt;
  version: 2;
  projectionDigest: string | null;
  catalogDigest: string | null;
  confirmed: string[];
  deferred: Array<{ name: string; reason: 'not_authorized' | 'projection_budget' | 'provider_schema_rejected' }>;
}
/** Receipt is derived from the final outgoing request, never from tier state. */
export function toolProjectionReceipt(requested: Iterable<string>, visible: ReadonlySet<string>, authorized: ReadonlySet<string>, projectionDigest: string | null, catalogDigest: string | null, rejectedSchemas: ReadonlySet<string> = new Set()): ToolProjectionReceipt {
  const names = [...new Set([...requested, ...rejectedSchemas])].sort();
  const reason = (name: string) => !authorized.has(name) ? 'not_authorized' as const
    : rejectedSchemas.has(name) ? 'provider_schema_rejected' as const : 'projection_budget' as const;
  return { version: 2, projectionDigest, catalogDigest,
    discovery: { schemaVersion: 1, revision: `${catalogDigest ?? 'unknown'}:${projectionDigest ?? 'pending'}`,
      tools: names.map(name => ({ name, state: visible.has(name) ? 'callable' : authorized.has(name) ? 'deferred' : 'denied',
        ...(!visible.has(name) ? { reason: reason(name) } : {}) })) },
    confirmed: names.filter(name => visible.has(name)),
    deferred: names.filter(name => !visible.has(name)).map(name => ({ name, reason: reason(name) })),
  };
}
