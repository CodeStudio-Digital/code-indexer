import type { Terminal } from '@xterm/xterm';
import { copyText, readClipboardText } from '../../../lib/clipboard.js';

/** Shared by interactive terminals and the read-only Output panel. */
export function installTerminalClipboard(term: Terminal, host: HTMLElement, readOnly = false): () => void {
  let disposed = false;
  const copy = async (): Promise<void> => {
    const selected = term.getSelection();
    if (selected) await copyText(selected);
  };
  const paste = async (): Promise<void> => {
    const text = await readClipboardText();
    if (text && !disposed) term.paste(text);
  };
  term.attachCustomKeyEventHandler(event => {
    if (event.type !== 'keydown' || event.altKey) return true;
    const primary = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const wantsCopy = primary && key === 'c' && (event.shiftKey || term.hasSelection());
    const wantsPaste = !readOnly && ((primary && key === 'v') || (event.shiftKey && key === 'insert'));
    if (!wantsCopy && !wantsPaste) return true; // Ctrl+C without selection remains SIGINT.
    event.preventDefault(); // prevent Chromium/xterm from also pasting the same text
    event.stopPropagation();
    void (wantsCopy ? copy() : paste());
    return false;
  });
  const onContextMenu = (event: MouseEvent): void => {
    if (!term.hasSelection() && readOnly) return;
    event.preventDefault();
    event.stopPropagation();
    void (term.hasSelection() ? copy() : paste());
  };
  host.addEventListener('contextmenu', onContextMenu);
  return () => { disposed = true; host.removeEventListener('contextmenu', onContextMenu); };
}
