/** Producer-owned desktop preview protocol. No tool runtime is loaded. */
import type { PreviewAuthority } from './authority.js';
import type { PreviewDispatchScope } from '@mcp/services/preview/contracts.js';

/** A single agent→devtools request. `key` scopes the window per agent. */
export interface PreviewInvoke {
  key: string;
  method:
    | 'open'
    | 'close'
    // Lifecycle (backend-triggered, not agent-facing): closeWindow frees the
    // BrowserWindow at turn end but keeps any preview-owned dev server alive
    // for reuse; closeSession also stops the owned server (session evict).
    | 'closeWindow'
    | 'closeSession'
    | 'closeWindowPrefix'
    | 'closeSessionPrefix'
    | 'navigate'
    | 'viewport'
    | 'console'
    | 'network'
    | 'eval'
    | 'screenshot'
    | 'inspect_css'
    | 'performance'
    | 'memory'
    | 'storage'
    | 'snapshot'
    | 'click'
    | 'type'
    | 'fill'
    | 'wait_for'
    | 'press'
    | 'scroll'
    | 'hover'
    | 'double_click'
    | 'right_click'
    // Backend-only: offscreen screenshot of a URL (no agent window needed).
    // Used by builder checkpoints for timeline thumbnails.
    | 'thumbnail';
  args?: Record<string, unknown>;
  /** Correlates cancellation across worker -> host. */
  requestId?: string;
  runId?: number;
  authority?: PreviewAuthority;
}

export interface IPreviewDevtools {
  invoke(req: PreviewInvoke, scope?: PreviewDispatchScope): Promise<unknown>;
  /** Supports revalidation at each physical dispatch, including after awaits. */
  readonly authorityAttested?: true;
  closeOwnedScope?(key: string, owner: object): Promise<void>;
  existingRunners?(): Pick<import('@mcp/services/preview/contracts.js').PreviewRunnerBridge, 'list' | 'readBuffer' | 'pinnedPort'> | null;
  /** Best-effort cancellation for long-running open/wait/eval operations. */
  cancel?(requestId: string): void | Promise<void>;
}
