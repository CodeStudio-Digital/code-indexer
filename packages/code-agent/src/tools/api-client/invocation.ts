import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { assertMutationFence, combinedMutationSignal } from '@mcp/code-agent/core/mutation-fence.js';
import { ApiRequestOutcomeUnknown } from '@mcp/services/api-client/execute-request.js';
import type { ApiRequest } from '@mcp/store/api-client-types.js';
import { unknownToolOutcome } from '@mcp/code-agent/core/tool.js';
import { projectRequest, resolveEnvFor, type ApiCtx } from './shared.js';

/** Saved request/environment IDs are mutable aliases. Pin their data for this
 * invocation and recheck after scripts/file I/O, immediately before sending. */
export function apiInvocation(ctx: ToolContext, api: ApiCtx, requests: ApiRequest[], envId: number | undefined) {
  const snapshots = new Map(requests.map(req => [req.id, JSON.stringify(req)]));
  const environment = JSON.stringify(resolveEnvFor(api.store, api.projectId, envId));
  const signal = combinedMutationSignal(ctx.signal, ctx.mutationFence);
  return {
    signal,
    send: ctx.ports?.apiClient ? ctx.ports.apiClient.http.send.bind(ctx.ports.apiClient.http) : undefined,
    beforeDispatch: (req: { id: number }) => {
      signal?.throwIfAborted();
      ctx.ports?.apiClient?.assertCurrent();
      if (!snapshots.has(req.id) || JSON.stringify(projectRequest(api, req.id)) !== snapshots.get(req.id)
        || JSON.stringify(resolveEnvFor(api.store, api.projectId, envId)) !== environment) {
        throw new Error('API request or environment changed during this invocation; inspect it before retrying');
      }
      assertMutationFence(ctx.mutationFence, { kind: 'control', operation: 'api.network', resource: String(req.id) });
    },
  };
}

export function uncertainApiResult(ctx: ToolContext, error: unknown) {
  if (!(error instanceof ApiRequestOutcomeUnknown)) return undefined;
  ctx.ports?.apiClient?.http.outcomeUnknown();
  return unknownToolOutcome(error.message);
}
