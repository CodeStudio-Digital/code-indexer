import type { SessionScope } from './types.js';

export interface Props {
  scope: SessionScope;
  sessionId: string;
  /** When provided, the panel will refetch every time the value changes — used to react
   *  to live `session_snapshot_changed` SSE events from the chat stream. */
  refreshKey?: number;
  /** Baseline to preselect on open (deep-link from a chat "View snapshot" action). */
  initialBaselineId?: string | null;
  onSubmitReviewMessage?: (message: string) => Promise<void>;
  /** Reserves room in the shared toolbar for the dialog's close control. */
  dialogMode?: boolean;
}
