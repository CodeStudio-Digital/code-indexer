export type {
  IResearchBrowser,
  ResearchBrowserInvoke,
  ResearchBrowserMethod,
} from '@mcp/shared/research-browser.js';

import type { BrowserContext, BrowserContextOptions } from 'playwright-core';

export type ResearchBrowserContext = Pick<BrowserContext, 'route' | 'routeWebSocket' | 'newPage' | 'on' | 'close'>;

export interface ResearchBrowserHost {
  newContext(options?: BrowserContextOptions): Promise<ResearchBrowserContext>;
}

export type ResearchBrowserConnector = () => Promise<ResearchBrowserHost | null>;
export type ResearchBrowserHostResolver = (hostname: string) => Promise<string[]>;
