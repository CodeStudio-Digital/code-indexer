/**
 * Offscreen thumbnail capture for builder checkpoints: load a dev-server
 * URL in a hidden sandboxed BrowserWindow, wait for the page to settle,
 * capture, downscale and persist as JPEG. Self-contained — no CDP attach,
 * no per-agent key, always destroys its window.
 *
 * Best-effort by contract: any failure (server down, navigation error,
 * timeout) resolves `{ok:false}` — checkpoint rows simply keep a null
 * screenshot and the timeline shows a placeholder.
 */
import { BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ThumbnailRequest {
  url: string;
  /** Capture viewport width (default 1280×800). */
  width?: number;
  height?: number;
  /** Downscaled output width (default 480). */
  thumbWidth?: number;
  /** Absolute output path — extension decides nothing; always JPEG bytes. */
  outPath: string;
  timeoutMs?: number;
}

export type ThumbnailResult = { ok: true; path: string } | { ok: false; error: string };

const SETTLE_MS = 800;

export async function captureThumbnail(req: ThumbnailRequest): Promise<ThumbnailResult> {
  const width = req.width ?? 1280;
  const height = req.height ?? 800;
  const timeoutMs = req.timeoutMs ?? 12_000;
  let win: BrowserWindow | null = null;
  try {
    win = new BrowserWindow({
      show: false,
      width,
      height,
      webPreferences: {
        sandbox: true,
        partition: 'mcp-thumbnail', // isolated, no preload, no electronAPI
        backgroundThrottling: false,
      },
    });
    const w = win;

    await withTimeout(w.loadURL(req.url), timeoutMs, 'navigation timed out');
    // Vite apps paint right after load; a short settle covers fonts/async UI.
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    if (w.isDestroyed()) return { ok: false, error: 'window destroyed mid-capture' };

    const image = await withTimeout(w.capturePage(), timeoutMs, 'capture timed out');
    const thumbWidth = req.thumbWidth ?? 480;
    const scaled = image.getSize().width > thumbWidth ? image.resize({ width: thumbWidth }) : image;
    const bytes = scaled.toJPEG(80);
    if (bytes.length === 0) return { ok: false, error: 'empty capture' };

    mkdirSync(dirname(req.outPath), { recursive: true });
    writeFileSync(req.outPath, bytes);
    return { ok: true, path: req.outPath };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    try {
      if (win && !win.isDestroyed()) win.destroy();
    } catch {
      /* already gone */
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
