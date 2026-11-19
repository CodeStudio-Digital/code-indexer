export type {
  IResearchBrowser,
  ResearchBrowserInvoke,
  ResearchBrowserMethod,
} from '@mcp/shared/research-browser.js';

import type { BrowserContext, BrowserContextOptions } from 'playwright-core';

export type ResearchBrowserContext = Pick<BrowserContext, 'route' | 'routeWebSocket' | 'newPage' | 'on' | 'close'>
  & Partial<Pick<BrowserContext, 'clearPermissions'>>;

export interface ResearchBrowserHost {
  newContext(options?: BrowserContextOptions): Promise<ResearchBrowserContext>;
  isConnected?(): boolean;
  once?(event: 'disconnected', listener: () => void): unknown;
}

export type ResearchBrowserConnector = () => Promise<ResearchBrowserHost | null>;
export type ResearchBrowserHostResolver = (hostname: string) => Promise<string[]>;
