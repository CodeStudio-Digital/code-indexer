/**
 * Plugin UI Kit — data layer: the Podman-Desktop-class primitives the legacy
 * kit lacked. Real data table (status pills + hover row actions), master-detail
 * / nav-rail with icons, page header, stat tiles, rich empty/loading/error
 * states. Same contract as the other layers: every top-level selector starts
 * with `.mcp-` (the hygiene test enforces it), themed via host CSS variables
 * with fallbacks, no `@media` (only `@keyframes mcp-*` is allowed at top level).
 *
 * Names are deliberately new (`.mcp-dtable`, `.mcp-status`, `.mcp-shell`, …) so
 * the legacy `.mcp-table`/`.mcp-row` plugins keep rendering identically.
 */
export const KIT_DATA = `
.mcp-dtable { overflow: auto; min-height: 0; border: 1px solid var(--border, #e5e7eb); border-radius: 8px; }
.mcp-dtable table { border-collapse: collapse; width: 100%; font-size: 13px; }
.mcp-dtable th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--card, #fff);
  text-align: left;
  font-weight: 600;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: .04em;
  color: var(--muted-foreground, #6b7280);
  padding: 8px 10px;
  border-bottom: 1px solid var(--border, #e5e7eb);
  white-space: nowrap;
}
.mcp-dtable td {
  padding: 7px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--border, #e5e7eb) 55%, transparent);
  vertical-align: middle;
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mcp-dtable th.num, .mcp-dtable td.num { text-align: right; font-variant-numeric: tabular-nums; }
.mcp-dtable td.mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; }
.mcp-dtable tbody tr:hover td { background: color-mix(in srgb, var(--muted, #f3f4f6) 55%, transparent); }
.mcp-dtable tr.pick { cursor: pointer; }
.mcp-dtable tr.selected td { background: var(--accent, #e0ecff); }
.mcp-dtable tbody tr:last-child td { border-bottom: 0; }

.mcp-cell-actions { text-align: right; white-space: nowrap; width: 1%; padding-left: 4px; }
.mcp-row-actions { display: inline-flex; gap: 2px; opacity: 0; transition: opacity .12s; }
.mcp-dtable tr:hover .mcp-row-actions, .mcp-dtable tr:focus-within .mcp-row-actions { opacity: 1; }

.mcp-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border, #e5e7eb);
  background: var(--muted, #f3f4f6);
  color: var(--muted-foreground, #6b7280);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.mcp-status::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
.mcp-status.ok { background: color-mix(in srgb, var(--success, #16a34a) 14%, transparent); border-color: color-mix(in srgb, var(--success, #16a34a) 35%, transparent); color: var(--success, #16a34a); }
.mcp-status.warn { background: color-mix(in srgb, var(--warning, #d97706) 14%, transparent); border-color: color-mix(in srgb, var(--warning, #d97706) 35%, transparent); color: var(--warning, #d97706); }
.mcp-status.err { background: color-mix(in srgb, var(--destructive, #dc2626) 12%, transparent); border-color: color-mix(in srgb, var(--destructive, #dc2626) 35%, transparent); color: var(--destructive, #dc2626); }
.mcp-status.info { background: color-mix(in srgb, var(--primary, #2563eb) 12%, transparent); border-color: color-mix(in srgb, var(--primary, #2563eb) 35%, transparent); color: var(--primary, #2563eb); }
.mcp-status.muted { color: var(--muted-foreground, #6b7280); }

.mcp-shell { flex: 1; min-height: 0; display: grid; grid-template-columns: var(--mcp-rail, 184px) minmax(0, 1fr); }
.mcp-shell.has-detail { grid-template-columns: var(--mcp-rail, 184px) minmax(0, 1fr) minmax(0, 1.1fr); }
.mcp-rail { min-height: 0; overflow: auto; padding: 8px; border-right: 1px solid var(--border, #e5e7eb); background: color-mix(in srgb, var(--muted, #f3f4f6) 40%, transparent); }
.mcp-rail-group { margin: 12px 0 4px; padding: 0 8px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted-foreground, #6b7280); }
.mcp-rail-group:first-child { margin-top: 2px; }
.mcp-nav {
  display: grid;
  grid-template-columns: 18px 1fr auto;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.mcp-nav:hover { background: var(--muted, #f3f4f6); }
.mcp-nav.active { background: var(--accent, #e0ecff); color: var(--accent-foreground, #1d4ed8); font-weight: 600; }
.mcp-nav-icon { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; color: var(--muted-foreground, #6b7280); }
.mcp-nav.active .mcp-nav-icon { color: inherit; }
.mcp-nav-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mcp-nav-count { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--muted-foreground, #9ca3af); }
.mcp-nav.active .mcp-nav-count { color: inherit; }
.mcp-content { min-width: 0; min-height: 0; overflow: auto; display: flex; flex-direction: column; }
.mcp-detail { min-width: 0; min-height: 0; overflow: auto; border-left: 1px solid var(--border, #e5e7eb); padding: 14px; }

.mcp-page-head { display: flex; flex-direction: column; gap: 10px; padding: 13px 16px; border-bottom: 1px solid var(--border, #e5e7eb); flex: none; }
.mcp-page-bar { display: flex; align-items: flex-start; gap: 12px; }
.mcp-page-titles { flex: 1; min-width: 0; }
.mcp-page-title { margin: 0; font-size: 15px; font-weight: 600; }
.mcp-page-sub { margin: 2px 0 0; font-size: 12px; color: var(--muted-foreground, #6b7280); line-height: 1.4; }
.mcp-page-actions { display: flex; align-items: center; gap: 6px; flex: none; }
.mcp-page-tools { display: flex; align-items: center; gap: 8px; }

.mcp-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.mcp-stat { border: 1px solid var(--border, #e5e7eb); border-radius: 10px; background: var(--card, #fff); padding: 10px 12px; }
.mcp-stat-label { font-size: 11px; color: var(--muted-foreground, #6b7280); }
.mcp-stat-value { margin-top: 2px; font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.2; }
.mcp-stat-delta { font-size: 11px; font-weight: 600; }
.mcp-stat-delta.up { color: var(--success, #16a34a); }
.mcp-stat-delta.down { color: var(--destructive, #dc2626); }

.mcp-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex: 1;
  min-height: 0;
  padding: 40px 20px;
  text-align: center;
  color: var(--muted-foreground, #6b7280);
}
.mcp-state-icon { display: inline-flex; color: var(--muted-foreground, #9ca3af); opacity: .7; }
.mcp-state.error .mcp-state-icon { color: var(--destructive, #dc2626); opacity: 1; }
.mcp-state-title { font-size: 13px; font-weight: 600; color: var(--foreground, #111827); }
.mcp-state-msg { font-size: 12px; max-width: 340px; line-height: 1.5; }
.mcp-state-actions { display: flex; gap: 8px; margin-top: 4px; }
`;
