import type { ToolContext } from '@mcp/code-agent/core/tool.js';
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
  if (ctx.signal?.aborted) throw new Error('Research browser operation aborted.');
  const pending = browser.invoke({ key: researchBrowserKey(ctx), method, args, requestId });
  if (!ctx.signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      void Promise.resolve(browser.cancel?.(requestId)).catch(() => undefined);
      reject(new Error('Research browser operation aborted.'));
    };
    ctx.signal!.addEventListener('abort', abort, { once: true });
    pending.then(
      (value: unknown) => {
        ctx.signal!.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        ctx.signal!.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
