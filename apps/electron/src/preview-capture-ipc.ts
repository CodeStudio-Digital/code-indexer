/**
 * Region screenshot for the INLINE preview iframe.
 *
 * The inline preview (`ProjectPreview`) is a cross-origin `<iframe>`, so the
 * renderer can't read its pixels. But the iframe is composited into the
 * dashboard window, and `webContents.capturePage(rect)` returns the painted
 * pixels (cross-origin iframes included). The renderer computes the box in
 * page-DIP coords (iframe offset + the marquee rect) and we clip the capture
 * to it. The CDP-window path uses `previewInspect.captureRegion` instead
 * (see preview-inspect-ipc.ts) since it has its own debugger.
 *
 * Channel: api:preview:captureRegion (dashboard calls `preview.captureRegion`).
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron';

interface Rect { x: number; y: number; width: number; height: number }

function ok(value: unknown) { return { ok: true as const, value }; }
function fail(err: unknown) {
  return { ok: false as const, error: { message: err instanceof Error ? err.message : String(err) } };
}

export function mountPreviewCaptureIpc(): void {
  ipcMain.handle('api:preview:captureRegion', async (e: IpcMainInvokeEvent, input: Rect) => {
    try {
      const rect = {
        x: Math.max(0, Math.round(input?.x ?? 0)),
        y: Math.max(0, Math.round(input?.y ?? 0)),
        width: Math.round(input?.width ?? 0),
        height: Math.round(input?.height ?? 0),
      };
      if (rect.width <= 0 || rect.height <= 0) throw new Error('captureRegion: empty rect');
      const img = await e.sender.capturePage(rect);
      return ok({ base64: img.toPNG().toString('base64') });
    } catch (err) {
      return fail(err);
    }
  });
}
