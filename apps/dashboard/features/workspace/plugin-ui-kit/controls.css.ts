/**
 * Plugin UI Kit — form controls. Same contract as base.css.ts: every selector
 * starts with `.mcp-`, themed exclusively through the host CSS variables
 * (with conservative fallbacks so a webview without injected vars still
 * renders legibly).
 */
export const KIT_CONTROLS = `
.mcp-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 28px;
  padding: 4px 10px;
  border: 1px solid var(--border, #d1d5db);
  border-radius: var(--radius, 6px);
  background: var(--card, #fff);
  color: var(--foreground, #111827);
  font: inherit;
  font-weight: 500;
  white-space: nowrap;
  user-select: none;
  cursor: pointer;
  transition: background .12s, border-color .12s, color .12s;
}
.mcp-btn:hover { background: var(--muted, #f3f4f6); }
.mcp-btn:active { transform: translateY(0.5px); }
.mcp-btn:disabled { cursor: default; opacity: .5; pointer-events: none; }
.mcp-btn.primary {
  background: var(--primary, #2563eb);
  border-color: var(--primary, #2563eb);
  color: var(--primary-foreground, #fff);
}
.mcp-btn.primary:hover { background: color-mix(in srgb, var(--primary, #2563eb) 88%, #000); }
.mcp-btn.danger {
  background: transparent;
  border-color: color-mix(in srgb, var(--destructive, #dc2626) 45%, var(--border, #d1d5db));
  color: var(--destructive, #dc2626);
}
.mcp-btn.danger:hover { background: color-mix(in srgb, var(--destructive, #dc2626) 10%, transparent); }
.mcp-btn.ghost { background: transparent; border-color: transparent; }
.mcp-btn.ghost:hover { background: var(--muted, #f3f4f6); }
.mcp-btn.sm { min-height: 24px; padding: 2px 8px; font-size: 11px; }
.mcp-btn.icon { width: 28px; padding: 0; flex: none; }
.mcp-btn.icon.sm { width: 24px; }

.mcp-input, .mcp-select, .mcp-textarea {
  width: 100%;
  min-height: 28px;
  border: 1px solid var(--input, var(--border, #d1d5db));
  border-radius: var(--radius, 6px);
  background: var(--card, #fff);
  color: inherit;
  font: inherit;
  padding: 4px 8px;
}
.mcp-input:focus, .mcp-select:focus, .mcp-textarea:focus {
  outline: 2px solid color-mix(in srgb, var(--ring, #4d8cff) 55%, transparent);
  outline-offset: 0;
  border-color: var(--ring, #4d8cff);
}
.mcp-input::placeholder, .mcp-textarea::placeholder {
  color: color-mix(in srgb, var(--muted-foreground, #6b7280) 75%, transparent);
}
.mcp-input.mono, .mcp-textarea.mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11.5px; }
.mcp-select {
  appearance: none;
  padding-right: 26px;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%23888f9c' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 8px center;
}
.mcp-textarea {
  min-height: 88px;
  resize: vertical;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11.5px;
  line-height: 1.5;
}

.mcp-field { display: flex; flex-direction: column; gap: 4px; margin: 0 0 10px; }
.mcp-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--muted-foreground, #6b7280);
  letter-spacing: .01em;
}
.mcp-hint { font-size: 10.5px; color: var(--muted-foreground, #6b7280); line-height: 1.4; }
.mcp-checkbox { width: 14px; height: 14px; margin: 0; accent-color: var(--primary, #2563eb); }
`;
