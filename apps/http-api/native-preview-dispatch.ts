import type { PreviewInvoke } from '@mcp/code-agent/tools/preview/index.js';
import { nativePreviewKey, previewDispatchArguments } from '@mcp/code-agent/tools/preview/authority.js';
import { authorizeNativeApplicationDispatch } from './native-application-dispatch.js';

export async function authorizeNativePreviewDispatch(request: PreviewInvoke,
  config: Parameters<typeof authorizeNativeApplicationDispatch>[1], projectId: number | null,
  store: Parameters<typeof authorizeNativeApplicationDispatch>[3], assertOwner: () => void) {
  return authorizeNativeApplicationDispatch(request, config, {
    name: `preview_${request.method}`, key: nativePreviewKey(config.context.sessionId, config.context.attemptId),
    operation: 'preview/dispatch', args: previewDispatchArguments(request.method, request.authority?.input ?? {}, projectId),
  }, store, assertOwner);
}
