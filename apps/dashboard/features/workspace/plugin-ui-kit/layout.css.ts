/**
 * Plugin UI Kit — layout/composite pieces: toolbar, cards, drill-in list
 * rows, tabs, tables, badges, empty/loading states, breadcrumb, log stream.
 * Same contract as base.css.ts: `.mcp-`-prefixed selectors only (the test
 * suite enforces it), themed via host CSS variables with fallbacks.
 */
export const KIT_LAYOUT = `
.mcp-toolbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }

.mcp-card {
  border: 1px solid var(--border, #e5e7eb);
  border-radius: calc(var(--radius, 6px) + 2px);
  background: var(--card, #fff);
  padding: 10px 12px;
}
.mcp-card-title { display: flex; align-items: center; gap: 6px; margin: 0 0 2px; font-size: 12px; font-weight: 700; }
.mcp-card-sub { margin: 0; color: var(--muted-foreground, #6b7280); font-size: 11px; line-height: 1.4; }

.mcp-section { margin: 12px 0 6px; }
.mcp-section-title {
  margin: 0 0 6px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .06em;
  color: var(--muted-foreground, #6b7280);
}

.mcp-list { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.mcp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.mcp-row:hover { background: var(--muted, #f3f4f6); }
.mcp-row.active { background: var(--accent, #e0ecff); color: var(--accent-foreground, #1d4ed8); }
.mcp-row.static { cursor: default; }
.mcp-row.static:hover { background: transparent; }
.mcp-row-main { flex: 1; min-width: 0; }
.mcp-row-title { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mcp-row-meta { display: block; font-size: 10.5px; color: var(--muted-foreground, #6b7280); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mcp-row-chev { flex: none; color: var(--muted-foreground, #9ca3af); font-size: 13px; line-height: 1; }

.mcp-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border, #e5e7eb); }
.mcp-tab {
  border: 0;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  background: transparent;
  color: var(--muted-foreground, #6b7280);
  font: inherit;
  font-weight: 600;
  padding: 6px 10px;
  cursor: pointer;
}
.mcp-tab:hover { color: var(--foreground, #111827); }
.mcp-tab.active { color: var(--primary, #2563eb); border-bottom-color: var(--primary, #2563eb); }

.mcp-table { overflow: auto; min-height: 0; border: 1px solid var(--border, #e5e7eb); border-radius: 6px; }
.mcp-table table { border-collapse: collapse; width: max-content; min-width: 100%; font-size: 11px; }
.mcp-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--card, #fff);
  text-align: left;
  font-weight: 700;
  padding: 5px 8px;
  border-bottom: 1px solid var(--border, #e5e7eb);
  white-space: nowrap;
}
.mcp-table td {
  padding: 4px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--border, #e5e7eb) 55%, transparent);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10.5px;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mcp-table tr:hover td { background: color-mix(in srgb, var(--muted, #f3f4f6) 50%, transparent); }

.mcp-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--border, #e5e7eb);
  background: var(--muted, #f3f4f6);
  color: var(--muted-foreground, #6b7280);
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
}
.mcp-badge.ok {
  background: color-mix(in srgb, var(--success, #16a34a) 14%, transparent);
  border-color: color-mix(in srgb, var(--success, #16a34a) 35%, transparent);
  color: var(--success, #16a34a);
}
.mcp-badge.warn {
  background: color-mix(in srgb, var(--warning, #d97706) 14%, transparent);
  border-color: color-mix(in srgb, var(--warning, #d97706) 35%, transparent);
  color: var(--warning, #d97706);
}
.mcp-badge.err {
  background: color-mix(in srgb, var(--destructive, #dc2626) 12%, transparent);
  border-color: color-mix(in srgb, var(--destructive, #dc2626) 35%, transparent);
  color: var(--destructive, #dc2626);
}
.mcp-badge.info {
  background: color-mix(in srgb, var(--primary, #2563eb) 12%, transparent);
  border-color: color-mix(in srgb, var(--primary, #2563eb) 35%, transparent);
  color: var(--primary, #2563eb);
}

.mcp-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 28px 12px;
  color: var(--muted-foreground, #6b7280);
  text-align: center;
  font-size: 11.5px;
}
.mcp-empty-icon { font-size: 20px; opacity: .6; }

.mcp-spinner {
  width: 14px;
  height: 14px;
  flex: none;
  border: 2px solid color-mix(in srgb, var(--muted-foreground, #9ca3af) 30%, transparent);
  border-top-color: var(--primary, #2563eb);
  border-radius: 50%;
  animation: mcp-spin .7s linear infinite;
}
@keyframes mcp-spin { to { transform: rotate(360deg); } }
.mcp-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  color: var(--muted-foreground, #6b7280);
}

.mcp-breadcrumb { display: flex; align-items: center; gap: 2px; min-width: 0; font-size: 11px; }
.mcp-crumb {
  background: none;
  border: 0;
  padding: 2px 4px;
  border-radius: 4px;
  color: var(--muted-foreground, #6b7280);
  font: inherit;
  cursor: pointer;
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mcp-crumb:hover { background: var(--muted, #f3f4f6); color: var(--foreground, #111827); }
.mcp-crumb.current { color: var(--foreground, #111827); font-weight: 700; cursor: default; }
.mcp-crumb.current:hover { background: transparent; }
.mcp-crumb-sep { flex: none; color: var(--muted-foreground, #9ca3af); opacity: .6; }

.mcp-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }

.mcp-log {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 6px;
  background: color-mix(in srgb, var(--muted, #f3f4f6) 45%, transparent);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
`;
