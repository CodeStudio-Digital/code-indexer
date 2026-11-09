import { copyText, readClipboardText } from './clipboard.js';

interface MonacoClipboardService {
  writeText(text: string, type?: string): Promise<void>;
  readText(type?: string): Promise<string>;
  readFindText(): Promise<string>;
  writeFindText(text: string): Promise<void>;
  readResources(): Promise<unknown[]>;
  clearInternalState(): void;
}

/**
 * Replacement for Monaco's browser clipboard service.
 *
 * Monaco's default service installs a WebKit workaround that pre-arms
 * `navigator.clipboard.write()` on every editor click/keydown. In WebViews or
 * browser sessions where that permission is denied, the workaround logs a
 * noisy `NotAllowedError` plus a canceled deferred promise even when the user
 * is not copying anything. The editor's regular copy action already goes
 * through `document.execCommand('copy')`, so this service only handles the
 * async clipboard entry points Monaco uses for paste fallback, find text, and
 * diff/special copy commands.
 */
export function createMonacoClipboardService(): MonacoClipboardService {
  const typedText = new Map<string, string>();
  let findText = '';
  let resources: unknown[] = [];

  return {
    async writeText(text, type) {
      resources = [];
      if (type) {
        typedText.set(type, text);
        return;
      }
      await copyText(text);
    },

    async readText(type) {
      if (type) return typedText.get(type) ?? '';
      return readClipboardText();
    },

    async readFindText() {
      return findText;
    },

    async writeFindText(text) {
      findText = text;
    },

    async readResources() {
      return [...resources];
    },

    clearInternalState() {
      resources = [];
    },
  };
}
