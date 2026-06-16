/**
 * Dashboard-driven "Inspect" IPC bridge — lets the renderer drive the CDP
 * preview window for UNIVERSAL element selection on ANY running project
 * (Angular/Next/OpenNext/React/Vue), independent of the agent's `preview_*`
 * tools. Electron-only (the CDP window lives in the main process); in browser
 * dev these channels are absent and the dashboard hides the Inspect button.
 *
 * Channels (renderer builds them from the dotted path, like every other call):
 *   api:previewInspect:open   { projectId, url }   → open window + arm inspector
 *   api:previewInspect:disarm { projectId }        → stop selecting (window stays)
 *   api:previewInspect:close  { projectId }        → close the window
 *   stream:api:previewInspect:events { projectId } → MessagePort of mcp:select descriptors
 *
 * Wire shapes mirror handlers-mount.ts so `apiCall`/`apiStream` work unchanged:
 *   invoke → { ok: true, value } | { ok: false, error: { message } }
 *   stream → { type: 'value', value } frames over a transferred MessagePort.
 */
import { ipcMain, MessageChannelMain, type IpcMainEvent } from 'electron';
import type { PreviewWindowService } from './preview-window/service.js';

/** Distinct from agent keys (coder-/company-*) so dashboard inspect windows
 *  never collide with an agent's own preview window. */
function inspectKey(projectId: number | string): string {
  return `inspect-${projectId}`;
}

function ok(value: unknown) { return { ok: true as const, value }; }
function fail(err: unknown) {
  return { ok: false as const, error: { message: err instanceof Error ? err.message : String(err) } };
}

export function mountPreviewInspectIpc(service: PreviewWindowService): void {
  ipcMain.handle('api:previewInspect:open', async (_e, input: { projectId: number; url: string; arm?: boolean }) => {
    try {
      return ok(await service.openInspect(inspectKey(input.projectId), String(input.url ?? ''), { arm: !!input.arm }));
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('api:previewInspect:focus', async (_e, input: { projectId: number }) => {
    try {
      service.focusInspect(inspectKey(input.projectId));
      return ok({ ok: true });
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('api:previewInspect:disarm', async (_e, input: { projectId: number }) => {
    try {
      await service.disarmInspect(inspectKey(input.projectId));
      return ok({ ok: true });
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('api:previewInspect:close', async (_e, input: { projectId: number }) => {
    try {
      service.closeKey(inspectKey(input.projectId));
      return ok({ ok: true });
    } catch (err) {
      return fail(err);
    }
  });

  // Region screenshot for the CDP preview window: clip Page.captureScreenshot to
  // the marquee box (in the window's own viewport coords — no offset needed).
  ipcMain.handle(
    'api:previewInspect:captureRegion',
    async (_e, input: { projectId: number; clip: { x: number; y: number; width: number; height: number } }) => {
      try {
        const res = (await service.invoke({
          key: inspectKey(input.projectId),
          method: 'screenshot',
          args: { clip: input.clip },
        })) as { base64?: string };
        return ok({ base64: res?.base64 ?? null });
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.on('stream:api:previewInspect:events', (event: IpcMainEvent, msg: { requestId: string; payload: { projectId: number } }) => {
    const { requestId, payload } = msg;
    const { port1, port2 } = new MessageChannelMain();
    event.sender.postMessage(`stream-port:${requestId}`, null, [port1]);
    port2.start();
    const unsub = service.onInspectSelect(inspectKey(payload.projectId), (d) => {
      try { port2.postMessage({ type: 'value', value: d }); } catch { /* port closed */ }
    });
    port2.on('close', () => unsub());
  });
}
