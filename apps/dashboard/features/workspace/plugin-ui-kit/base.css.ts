/**
 * Plugin UI Kit — base layer. Injected by the host into EVERY plugin webview
 * (see plugin-iframe-runtime.ts) right after `<head>` opens, so it sits
 * BEFORE the author's own <style> and any plugin rule wins ties.
 *
 * Golden rule: every selector is namespaced under `.mcp-` — never add a bare
 * element selector (`button`, `*`, …). Plugins that style raw elements
 * themselves (Podman, the legacy CF panel) must keep rendering identically
 * whether or not this kit is present. Scoped descendants (`.mcp-app *`) are
 * fine: they only apply when the author opts in with the class.
 */
export const KIT_BASE = `
.mcp-app, .mcp-app *, .mcp-app *::before, .mcp-app *::after { box-sizing: border-box; }
.mcp-app {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  font-family: var(--font-sans, system-ui);
  font-size: 12px;
  line-height: 1.45;
  background: var(--background, #fff);
  color: var(--foreground, #111827);
}
.mcp-app, .mcp-app * {
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--muted-foreground, #9ca3af) 38%, transparent) transparent;
}
.mcp-app::-webkit-scrollbar, .mcp-app ::-webkit-scrollbar { width: 9px; height: 9px; }
.mcp-app::-webkit-scrollbar-track, .mcp-app ::-webkit-scrollbar-track { background: transparent; }
.mcp-app::-webkit-scrollbar-thumb, .mcp-app ::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--muted-foreground, #9ca3af) 34%, transparent);
  border-radius: 999px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
.mcp-app::-webkit-scrollbar-thumb:hover, .mcp-app ::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--muted-foreground, #9ca3af) 60%, transparent);
  background-clip: padding-box;
}
.mcp-app::-webkit-scrollbar-corner, .mcp-app ::-webkit-scrollbar-corner { background: transparent; }
.mcp-app :focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ring, #4d8cff) 70%, transparent);
  outline-offset: 1px;
}

.mcp-mono { font-family: var(--font-mono, ui-monospace, monospace); }
.mcp-muted { color: var(--muted-foreground, #6b7280); }
.mcp-xs { font-size: 11px; }
.mcp-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mcp-grow { flex: 1; min-width: 0; min-height: 0; }
.mcp-scroll { overflow: auto; min-height: 0; }
.mcp-stack { display: flex; flex-direction: column; gap: 10px; }
.mcp-hstack { display: flex; align-items: center; gap: 6px; min-width: 0; }

.mcp-divider { height: 1px; background: var(--border, #e5e7eb); border: 0; margin: 8px 0; }
.mcp-kbd {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10px;
  padding: 1px 5px;
  border: 1px solid var(--border, #d1d5db);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--muted, #f3f4f6);
}
.mcp-link {
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  color: var(--primary, #2563eb);
  text-decoration: none;
  cursor: pointer;
}
.mcp-link:hover { text-decoration: underline; }

.mcp-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted-foreground, #9ca3af); flex: none; }
.mcp-dot.ok { background: var(--success, #16a34a); }
.mcp-dot.warn { background: var(--warning, #d97706); }
.mcp-dot.err { background: var(--destructive, #dc2626); }
`;
