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
}

export interface IResearchBrowser {
  invoke(request: ResearchBrowserInvoke): Promise<unknown>;
  cancel?(requestId: string): void | Promise<void>;
  closeAll?(): void | Promise<void>;
}
