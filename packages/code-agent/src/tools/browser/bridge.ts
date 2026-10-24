import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { asAbortSignal } from '@mcp/code-agent/core/abort-signal.js';
import { cancellableToolRpc } from '../cancellable-rpc.js';
import { assertMutationFence } from '../../core/mutation-fence.js';
import { BrowserOutcomeUnknownError } from './failure.js';
import type {
  IResearchBrowser,
  ResearchBrowserInvoke,
  ResearchBrowserMethod,
} from '@mcp/shared/research-browser.js';

export type { IResearchBrowser, ResearchBrowserInvoke, ResearchBrowserMethod };

let globalBrowser: IResearchBrowser | null = null;
let requestSequence = 0;

export function setGlobalResearchBrowser(browser: IResearchBrowser | null): void {
  globalBrowser = browser;
}

export function getGlobalResearchBrowser(): IResearchBrowser | null {
  return globalBrowser;
}

export function researchBrowserRpcTimeoutMs(request: ResearchBrowserInvoke): number {
  if (request.method === 'open') return 45_000;
  if (request.method === 'screenshot') return 25_000;
  return 20_000;
}

export function researchBrowserKey(ctx: ToolContext): string {
  const company = ctx.companyContext as { agentRunId?: string; companySessionId?: string } | undefined;
  if (company?.agentRunId != null && company.companySessionId != null) {
    return `company-session-${company.companySessionId}-agent-${company.agentRunId}`;
  }
  return `coder-${ctx.sessionId ?? 'main'}`;
}

export async function invokeResearchBrowser(
  ctx: ToolContext,
  method: ResearchBrowserMethod,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const browser = getGlobalResearchBrowser();
  if (!browser) throw new Error('Research browser is unavailable in this runtime.');
  const requestId = `browser-${Date.now().toString(36)}-${(++requestSequence).toString(36)}`;
  const signal = asAbortSignal(ctx.signal);
  signal?.throwIfAborted();
  const key = researchBrowserKey(ctx);
  assertMutationFence(ctx.mutationFence, { kind: 'control', operation: `browser.${method}`, resource: key });
  let dispatched = false;
  try {
    return await cancellableToolRpc(() => {
      dispatched = true;
      return browser.invoke({ key, method, args, requestId });
    }, () => browser.cancel?.(requestId), signal, 'Research browser operation aborted.');
  } catch (error) {
    if (dispatched && ['open', 'click', 'fill', 'press', 'close'].includes(method)) {
      throw new BrowserOutcomeUnknownError(error);
    }
    throw error;
  }
}
