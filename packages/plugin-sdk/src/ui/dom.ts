/** Tiny DOM helpers — plugin UIs are vanilla TS over the host-injected `.mcp-*`
 *  kit. These wrap createElement and the inline SVG icon set. */
import { ICONS } from './icons.js';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string | null,
  text?: string | null,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

export function div(cls?: string | null, ...children: Array<Node | string>): HTMLDivElement {
  const node = el('div', cls);
  for (const c of children) node.append(c);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An inline lucide icon as an <svg> that inherits `currentColor` and the size. */
export function icon(name: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] ?? ICONS['circle-alert'];
  return svg;
}

export function button(
  label: string,
  cls: string,
  onClick: (ev: MouseEvent) => void,
): HTMLButtonElement {
  const b = el('button', `mcp-btn ${cls}`.trim(), label);
  b.type = 'button';
  b.onclick = onClick;
  return b;
}

/** Icon-only ghost button (table row actions, toolbars). `extra` adds classes
 *  like `danger`. Takes an icon NAME (rendered as inline SVG). */
export function iconBtn(
  name: string,
  title: string,
  onClick: (ev: MouseEvent) => void,
  extra?: string,
): HTMLButtonElement {
  const b = el('button', `mcp-btn ghost icon sm${extra ? ' ' + extra : ''}`);
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.appendChild(icon(name, 15));
  b.onclick = onClick;
  return b;
}

/** Legacy text-symbol ghost button (kept for back-compat with older plugins). */
export function iconButton(symbol: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = button(symbol, 'ghost icon sm', onClick);
  b.title = title;
  b.setAttribute('aria-label', title);
  return b;
}

export function input(placeholder?: string, type = 'text'): HTMLInputElement {
  const i = el('input', 'mcp-input');
  i.type = type;
  if (placeholder) i.placeholder = placeholder;
  return i;
}

export function textarea(placeholder?: string, value = ''): HTMLTextAreaElement {
  const t = el('textarea', 'mcp-textarea');
  if (placeholder) t.placeholder = placeholder;
  t.value = value;
  return t;
}

export function select(
  options: Array<{ value: string; label: string; selected?: boolean }>,
): HTMLSelectElement {
  const s = el('select', 'mcp-select');
  for (const o of options) {
    const opt = el('option', null, o.label);
    opt.value = o.value;
    if (o.selected) opt.selected = true;
    s.appendChild(opt);
  }
  return s;
}

/** Labelled form field (label above control), kit-styled. */
export function field(label: string, control: HTMLElement, hint?: string): HTMLDivElement {
  const wrap = div('mcp-field');
  wrap.appendChild(el('span', 'mcp-label', label));
  wrap.appendChild(control);
  if (hint) wrap.appendChild(el('span', 'mcp-hint', hint));
  return wrap;
}

export function clear(node: HTMLElement): void {
  node.textContent = '';
}

export function setChildren(node: HTMLElement, ...children: Array<Node | string>): void {
  clear(node);
  for (const c of children) node.append(c);
}
