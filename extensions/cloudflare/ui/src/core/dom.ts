/** Tiny DOM helpers — the UI is vanilla TS over the host-injected .mcp-* kit. */

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

export function select(options: Array<{ value: string; label: string; selected?: boolean }>): HTMLSelectElement {
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
