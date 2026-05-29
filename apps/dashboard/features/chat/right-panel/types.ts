/**
 * Right-panel identifiers — one per "tool window" that the activity rail
 * can toggle. The rail renders the icon for each id, and `RightPanelHost`
 * routes the active id to the corresponding panel component.
 *
 * Snapshots is intentionally NOT in this union: its content (file diff
 * viewer) needs the full viewport width to be useful, so its rail button
 * opens a full-screen modal instead of a sidebar panel. The other six
 * tools fit comfortably in a 320-600px resizable panel.
 */
export type RightPanelId =
  | 'meta'        // Goal / tasks / files / skills picker (was SessionStateSidebar)
  | 'skills'      // Per-session skill enable/disable (was SkillConfigDialog)
  | 'tools'       // Per-session tool enable/disable (was ToolConfigDialog)
  | 'metrics'     // Token / cost / turn metrics (was SessionMetricsModal)
  | 'tool-stats'  // Aggregated coder_tool_calls breakdown (was ToolStatsModal)
  | 'details'     // Session details + stats (was SessionDetailsModal)
  | 'worker-log'; // Endpoint/hook/tool inspector (was WorkerLogPanel inline 440px)

export interface RightPanelDef {
  id: RightPanelId;
  /** Lucide icon component name (passed as React element type). */
  iconName: string;
  /** Translation key under `chat:rightRail.<id>`. */
  labelKey: string;
}
