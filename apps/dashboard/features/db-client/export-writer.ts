import { downloadBlob } from '../api-client/download.js';

/** Native writes are incremental; browser fallback has an explicit 16 MiB cap. */
export async function createExportWriter(name: string, mime: string) {
  const picker = (window as unknown as { showSaveFilePicker?: (options: unknown) => Promise<{ createWritable(): Promise<{ write(value: string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }> }> }).showSaveFilePicker;
  if (picker) {
    let handle;
    try { handle = await picker({ suggestedName: name }); }
    catch (error) { if ((error as Error).name === 'AbortError') return null; throw error; }
    const stream = await handle.createWritable();
    return { write: (value: string) => stream.write(value), close: () => stream.close(), abort: () => stream.abort() };
  }
  const parts: string[] = []; let bytes = 0;
  return {
    async write(value: string) {
      bytes += new TextEncoder().encode(value).byteLength;
      if (bytes > 16 * 1024 * 1024) throw new Error('Export exceeds the browser memory limit (16 MiB). Use the desktop file picker for a larger export.');
      parts.push(value);
    },
    async close() { downloadBlob(name, new Blob(parts, { type: mime })); parts.length = 0; },
    async abort() { parts.length = 0; },
  };
}
