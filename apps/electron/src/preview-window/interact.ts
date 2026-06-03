/**
 * Real user-input simulation over CDP for the agent preview window — click,
 * type, fill, wait-for-element, and key press. Backed by the `Input` domain
 * (no enable needed). Element targeting (CSS or `text="..."`) is delegated to
 * `locate()` so the agent can drive real login/UI flows (clicks fire React
 * handlers; insertText updates controlled inputs) instead of poking the DOM
 * via `eval`.
 */
import type { PreviewWindow } from './cdp.js';
import { locate } from './interact-locate.js';

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

// ─── Keyboard ─────────────────────────────────────────────────────────────
const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
};
const MOD_BITS: Record<string, number> = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, super: 4, shift: 8 };

function modBit(name: string): number {
  const low = name.toLowerCase();
  if (low === 'mod') return process.platform === 'darwin' ? 4 : 2;
  return MOD_BITS[low] ?? 0;
}

/**
 * Press a key: a named key (Enter, Tab, Arrow*), a single character, or a
 * combo like "Meta+k" / "Control+a" / "Shift+Tab". Extra modifiers may also
 * come via `extraMods`. Text is inserted only for printable keys with no
 * Ctrl/Meta/Alt held (a shortcut must not type its character).
 */
async function pressKey(pw: PreviewWindow, spec: string, extraMods?: string[]): Promise<void> {
  const parts = spec.split('+').map((s) => s.trim()).filter(Boolean);
  const keyName = parts.pop() ?? '';
  let mods = 0;
  let hasCMA = false; // Ctrl/Meta/Alt held → treat as shortcut
  for (const m of [...parts, ...(extraMods ?? [])]) {
    const bit = modBit(m);
    if (bit) { mods |= bit; if (bit !== 8) hasCMA = true; }
  }

  let desc: { key: string; code?: string; vk?: number; text?: string };
  const named = KEYS[keyName];
  if (named) {
    desc = { key: keyName, code: named.code, vk: named.keyCode, text: named.text };
  } else if ([...keyName].length === 1) {
    const upper = keyName.toUpperCase();
    const code = /[a-z]/i.test(keyName) ? `Key${upper}` : /[0-9]/.test(keyName) ? `Digit${keyName}` : undefined;
    desc = { key: keyName, code, vk: upper.charCodeAt(0), text: keyName };
  } else {
    throw new Error(
      `unsupported key '${keyName}'. Use a single character, a named key ` +
        `(${Object.keys(KEYS).join(', ')}), or a combo like "Meta+k" / "Shift+Tab".`,
    );
  }

  const base: Record<string, unknown> = { key: desc.key, modifiers: mods };
  if (desc.code) base.code = desc.code;
  if (desc.vk) { base.windowsVirtualKeyCode = desc.vk; base.nativeVirtualKeyCode = desc.vk; }
  const text = desc.text && !hasCMA ? desc.text : undefined;
  await pw.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text } : {}) });
  await pw.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

// ─── Pointer / text ─────────────────────────────────────────────────────────
async function click(pw: PreviewWindow, selector: string): Promise<unknown> {
  const t = await locate(pw, selector, 'coords');
  if (t.error) return { error: t.error };
  if (!t.found || t.x == null || t.y == null) return { error: `no element matched '${selector}'` };
  await pw.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: t.x, y: t.y, buttons: 0 });
  await pw.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: t.x, y: t.y, button: 'left', buttons: 1, clickCount: 1 });
  await pw.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: t.x, y: t.y, button: 'left', buttons: 0, clickCount: 1 });
  return { ok: true, x: Math.round(t.x), y: Math.round(t.y) };
}

async function type(pw: PreviewWindow, text: string, selector?: string): Promise<unknown> {
  if (selector) {
    const t = await locate(pw, selector, 'focus');
    if (t.error) return { error: t.error };
    if (!t.found) return { error: `no element matched '${selector}'` };
  }
  await pw.send('Input.insertText', { text });
  return { ok: true };
}

async function fill(pw: PreviewWindow, selector: string, value: string): Promise<unknown> {
  const t = await locate(pw, selector, 'fill');
  if (t.error) return { error: t.error };
  if (!t.found) return { error: `no element matched '${selector}'` };
  await pw.send('Input.insertText', { text: value });
  return { ok: true, value };
}

async function mouseAt(pw: PreviewWindow, x: number, y: number, button: 'left' | 'right', clickCount: number): Promise<void> {
  await pw.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  const buttons = button === 'right' ? 2 : 1;
  await pw.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount });
  await pw.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount });
}

async function doubleClick(pw: PreviewWindow, selector: string): Promise<unknown> {
  const t = await locate(pw, selector, 'coords');
  if (t.error) return { error: t.error };
  if (!t.found || t.x == null || t.y == null) return { error: `no element matched '${selector}'` };
  await mouseAt(pw, t.x, t.y, 'left', 2);
  return { ok: true, x: Math.round(t.x), y: Math.round(t.y) };
}

async function rightClick(pw: PreviewWindow, selector: string): Promise<unknown> {
  const t = await locate(pw, selector, 'coords');
  if (t.error) return { error: t.error };
  if (!t.found || t.x == null || t.y == null) return { error: `no element matched '${selector}'` };
  await mouseAt(pw, t.x, t.y, 'right', 1);
  return { ok: true, x: Math.round(t.x), y: Math.round(t.y) };
}

async function hover(pw: PreviewWindow, selector: string): Promise<unknown> {
  const t = await locate(pw, selector, 'coords');
  if (t.error) return { error: t.error };
  if (!t.found || t.x == null || t.y == null) return { error: `no element matched '${selector}'` };
  await pw.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: t.x, y: t.y, buttons: 0 });
  return { ok: true, x: Math.round(t.x), y: Math.round(t.y) };
}

async function scroll(pw: PreviewWindow, selector: string | undefined, x: number, y: number): Promise<unknown> {
  if (selector) {
    const t = await locate(pw, selector, 'coords'); // locate already scrollIntoView({center})
    if (t.error) return { error: t.error };
    if (!t.found) return { error: `no element matched '${selector}'` };
    return { ok: true, scrolledTo: selector };
  }
  await pw.send('Runtime.evaluate', {
    expression: `window.scrollBy({left:${Number(x) || 0},top:${Number(y) || 0},behavior:'instant'})`,
  });
  return { ok: true, dx: Number(x) || 0, dy: Number(y) || 0 };
}

async function waitFor(pw: PreviewWindow, selector: string, timeoutMs: number): Promise<unknown> {
  const deadline = Date.now() + clamp(timeoutMs, 200, 30_000);
  for (;;) {
    const t = await locate(pw, selector, 'coords');
    if (t.error) return { error: t.error };
    if (t.found) return { found: true };
    if (Date.now() >= deadline) return { found: false };
    await new Promise((res) => setTimeout(res, 150));
  }
}

/** Dispatch one of the interaction methods. Called from PreviewWindowService. */
export async function dispatchInteraction(
  pw: PreviewWindow,
  method: 'click' | 'type' | 'fill' | 'wait_for' | 'press' | 'scroll' | 'hover' | 'double_click' | 'right_click',
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case 'click':
      return click(pw, String(args.selector ?? ''));
    case 'double_click':
      return doubleClick(pw, String(args.selector ?? ''));
    case 'right_click':
      return rightClick(pw, String(args.selector ?? ''));
    case 'hover':
      return hover(pw, String(args.selector ?? ''));
    case 'scroll':
      return scroll(pw, args.selector ? String(args.selector) : undefined, Number(args.x ?? 0), Number(args.y ?? 0));
    case 'type':
      return type(pw, String(args.text ?? ''), args.selector ? String(args.selector) : undefined);
    case 'fill':
      return fill(pw, String(args.selector ?? ''), String(args.value ?? ''));
    case 'wait_for':
      return waitFor(pw, String(args.selector ?? ''), Number(args.timeoutMs ?? 5000));
    case 'press': {
      if (args.selector) {
        const t = await locate(pw, String(args.selector), 'focus');
        if (t.error) return { error: t.error };
      }
      const mods = Array.isArray(args.modifiers) ? (args.modifiers as unknown[]).map(String) : undefined;
      await pressKey(pw, String(args.key ?? ''), mods);
      return { ok: true };
    }
  }
}
