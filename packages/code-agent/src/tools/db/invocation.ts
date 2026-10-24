import type { ToolContext } from '../../core/tool.js';
import { assertMutationFence, combinedMutationSignal } from '../../core/mutation-fence.js';
import type { DbConnection } from '@mcp/store/db-client-store-types.js';
import { acquireAgentDriver } from './pool.js';

export function databaseInvocation(ctx: ToolContext, operation: string, resource: unknown) {
  const signal = combinedMutationSignal(ctx.signal, ctx.mutationFence);
  return { signal, assertDispatch: () => {
    signal?.throwIfAborted();
    assertMutationFence(ctx.mutationFence, { kind: 'database', operation, resource: String(resource ?? '<default>') });
  } };
}
export function acquireToolDriver(connection: DbConnection, ctx: ToolContext, operation: string, resource: unknown) {
  return ctx.ports?.database
    ? ctx.ports.database.acquire(connection, databaseInvocation(ctx, operation, resource))
    : acquireAgentDriver(connection);
}
