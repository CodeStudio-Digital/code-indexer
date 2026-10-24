import type { HostUiDispatchScope } from './host-ui-dispatch.js';

export type ResearchBrowserMethod =
  | 'open'
  | 'snapshot'
  | 'extract'
  | 'click'
  | 'fill'
  | 'press'
  | 'screenshot'
  | 'close'
  | 'closePrefix';

export interface ResearchBrowserInvoke {
  key: string;
  method: ResearchBrowserMethod;
  args?: Record<string, unknown>;
  requestId?: string;
  runId?: number;
  authority?: unknown;
}

export interface IResearchBrowser {
  invoke(request: ResearchBrowserInvoke, scope?: HostUiDispatchScope): Promise<unknown>;
  readonly authorityAttested?: true;
  closeOwnedScope?(key: string, owner: object): Promise<void>;
  cancel?(requestId: string): void | Promise<void>;
  closeAll?(): void | Promise<void>;
}

