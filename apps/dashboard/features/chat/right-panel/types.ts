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
export type BuiltinRightPanelId =
  | 'meta'        // Goal / tasks / files / skills picker (was SessionStateSidebar)
  | 'drive'       // Session Drive: working memory (map/notes/investigations/plans)
  | 'chapters'    // Navigable context/milestone/rebuild chapter history
  | 'config'      // Per-session Skills + Tools enable/disable, tabbed (was 'skills' + 'tools')
  | 'metrics'     // Token / cost / turn metrics (was SessionMetricsModal)
  | 'tool-stats'  // Aggregated coder_tool_calls breakdown (was ToolStatsModal)
  | 'plans'       // submit_plan history (was the Details "Planos" tab)
  | 'details'     // Session summary + inputs (was SessionDetailsModal; plans split out)
  | 'diagram'     // Live embedded draw.io editor (wide panel) for the diagram agent
  | 'notifications' // Session notification center: loop/run/quality notices + history
  | 'worker-log'; // Endpoint/hook/tool inspector (was WorkerLogPanel inline 440px)

/**
 * Plugin-contributed tool windows (side: 'right') join the rail with ids
 * shaped `plugin:<namespace>:<windowId>` — same convention as the Company
 * session's SidebarRail, resolved against the contribution registry.
 */
export type RightPanelId = BuiltinRightPanelId | `plugin:${string}`;

export interface RightPanelDef {
  id: RightPanelId;
  /** Lucide icon component name (passed as React element type). */
  iconName: string;
  /** Translation key under `chat:rightRail.<id>`. */
  labelKey: string;
}
