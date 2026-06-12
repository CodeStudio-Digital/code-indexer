/**
 * Stacked navigation for a 320–600px panel: one view on screen, push to
 * drill in (home → domain → resource → detail), pop to go back. The stack
 * persists via core/state so a webview remount restores where you were.
 * A view's render may return a cleanup fn — used to kill live streams when
 * navigating away.
 */
import { clear } from './dom.js';
import { saveStack, type Frame } from './state.js';

export type { Frame };

export interface View {
  id: string;
  /** Breadcrumb / header label for a frame of this view. */
  label(params: Record<string, string>): string;
  render(host: HTMLElement, params: Record<string, string>): void | (() => void);
}

const views = new Map<string, View>();
let stack: Frame[] = [{ view: 'home', params: {} }];
let host: HTMLElement | null = null;
let cleanup: (() => void) | null = null;
const listeners: Array<() => void> = [];

export function registerView(view: View): void {
  views.set(view.id, view);
}

export function viewLabel(frame: Frame): string {
  return views.get(frame.view)?.label(frame.params) ?? frame.view;
}

export function getStack(): readonly Frame[] {
  return stack;
}

export function current(): Frame {
  return stack[stack.length - 1];
}

/** Re-render listeners (the shell uses this for breadcrumb/back state). */
export function onNavigate(fn: () => void): void {
  listeners.push(fn);
}

export function push(view: string, params: Record<string, string> = {}): void {
  stack.push({ view, params });
  render();
}

export function pop(): void {
  if (stack.length > 1) stack.pop();
  render();
}

/** Jump back to an ancestor frame (breadcrumb click). */
export function popTo(index: number): void {
  if (index < 0 || index >= stack.length - 1) return;
  stack = stack.slice(0, index + 1);
  render();
}

export function home(): void {
  stack = [{ view: 'home', params: {} }];
  render();
}

/** Re-render the current frame (after a create/delete that changes a list). */
export function refresh(): void {
  render();
}

/** Mount the router. A persisted stack is validated against known views —
 *  anything unknown (renamed view, stale storage) falls back to home. */
export function initRouter(container: HTMLElement, restored: Frame[] | null): void {
  host = container;
  if (restored && restored.every((f) => views.has(f.view))) stack = restored;
  render();
}

function render(): void {
  if (!host) return;
  if (cleanup) {
    try {
      cleanup();
    } catch {
      /* stream teardown is best-effort */
    }
    cleanup = null;
  }
  clear(host);
  const frame = current();
  const view = views.get(frame.view) ?? views.get('home');
  if (!view) return;
  cleanup = view.render(host, frame.params) || null;
  saveStack(stack);
  for (const fn of listeners) fn();
}
