export type {
  IResearchBrowser,
  ResearchBrowserInvoke,
  ResearchBrowserMethod,
} from '@mcp/shared/research-browser.js';

export type ResearchBrowserConnector = () => Promise<import('playwright-core').Browser | null>;
export type ResearchBrowserHostResolver = (hostname: string) => Promise<string[]>;
