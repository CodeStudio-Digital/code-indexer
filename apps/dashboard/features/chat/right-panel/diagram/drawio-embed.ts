/**
 * draw.io embed protocol helpers (shared by the chat panel and the project
 * editor). The self-hosted editor speaks the JSON protocol (`proto=json`):
 * it posts JSON STRINGS to the parent and expects JSON STRINGS back.
 *
 * Origin note: the editor loads from `mcp://app` (Electron) or the dev backend
 * — a custom scheme whose `event.origin` is unreliable. The frame therefore
 * guards on `event.source === iframe.contentWindow` (the message really came
 * from OUR iframe) plus message-shape validation, which is scheme-agnostic.
 */

/** Base URL of the self-hosted draw.io editor (Electron mcp://app vs browser dev). */
export function drawioBaseUrl(): string {
  const isElectron =
    typeof window !== 'undefined' && !!(window as { electronAPI?: unknown }).electronAPI;
  return isElectron ? 'mcp://app/drawio' : '/drawio';
}

export interface DrawioUrlOpts {
  dark?: boolean;
  libraries?: boolean;
}

/** Build the embed URL with the JSON protocol + autosave UI enabled. */
export function drawioEmbedUrl(opts: DrawioUrlOpts = {}): string {
  const p = new URLSearchParams({
    embed: '1',
    proto: 'json',
    spin: '1',
    libraries: opts.libraries === false ? '0' : '1',
    noSaveBtn: '0',
    saveAndExit: '0',
    noExitBtn: '1',
    ui: opts.dark === false ? 'kennedy' : 'dark',
  });
  return `${drawioBaseUrl()}/index.html?${p.toString()}`;
}

/** Image export format requested via the `export` action. xml* embeds the
 *  editable diagram inside the image so the artifact round-trips. */
export type DrawioExportFormat = 'svg' | 'png';

/** Map our SVG/PNG intent to draw.io's editable export formats. */
export function toDrawioExportAction(format: DrawioExportFormat): 'xmlsvg' | 'xmlpng' {
  return format === 'png' ? 'xmlpng' : 'xmlsvg';
}

/** An inbound message from the embedded editor (already JSON-parsed). */
export interface DrawioEvent {
  event: string;
  xml?: string;
  data?: string;
  format?: string;
  message?: string;
  modified?: boolean;
}

/** Parse a raw postMessage payload into a DrawioEvent, or null if it's not one. */
export function parseDrawioEvent(data: unknown): DrawioEvent | null {
  if (typeof data !== 'string') return null;
  if (data.length === 0 || data[0] !== '{') return null;
  try {
    const obj = JSON.parse(data) as Record<string, unknown>;
    if (obj && typeof obj.event === 'string') return obj as DrawioEvent;
  } catch {
    /* not a drawio JSON frame */
  }
  return null;
}
