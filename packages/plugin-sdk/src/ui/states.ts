/** Empty / loading / error blocks. The rich `state()` builder backs them and is
 *  also usable directly for full-pane states with a title + actions. */
import { div, el, icon } from './dom.js';
import { errorMessage } from './api.js';
import { kitLabel } from './labels.js';

export interface StateSpec {
  /** Icon name from the SDK icon set (28px, centered). */
  icon?: string;
  title?: string;
  message?: string;
  variant?: 'default' | 'error';
  actions?: HTMLElement[];
}

/** Centered empty/error/info block with optional icon, title and actions. */
export function state(spec: StateSpec): HTMLElement {
  const box = div(`mcp-state${spec.variant === 'error' ? ' error' : ''}`);
  if (spec.icon) {
    const wrap = div('mcp-state-icon');
    wrap.appendChild(icon(spec.icon, 28));
    box.appendChild(wrap);
  }
  if (spec.title) box.appendChild(el('div', 'mcp-state-title', spec.title));
  if (spec.message) box.appendChild(el('div', 'mcp-state-msg', spec.message));
  if (spec.actions?.length) {
    const bar = div('mcp-state-actions');
    for (const a of spec.actions) bar.appendChild(a);
    box.appendChild(bar);
  }
  return box;
}

export function loadingBox(label?: string): HTMLElement {
  return div('mcp-loading', el('span', 'mcp-spinner'), el('span', null, label ?? kitLabel('loading')));
}

export function emptyBox(message: string, iconName = 'inbox'): HTMLElement {
  return state({ icon: iconName, message });
}

export function errorBox(e: unknown): HTMLElement {
  return state({ icon: 'circle-alert', message: errorMessage(e), variant: 'error' });
}

export function jsonPre(value: unknown): HTMLElement {
  const pre = el('pre', 'mcp-log');
  pre.textContent = typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2);
  return pre;
}
