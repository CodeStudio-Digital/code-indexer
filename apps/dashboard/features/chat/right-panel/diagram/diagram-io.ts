/**
 * Persistence helpers for the diagram surfaces — write the `.drawio` XML back
 * to disk (autosave/save) and persist an exported image next to it. Both reuse
 * the existing `files.write` API (encoding 'base64' decodes binary PNGs); no
 * dedicated endpoint needed. The backend enforces project-root containment.
 */
import { apiCall } from '../../../../lib/api-client.js';
import type { DrawioExportFormat } from './drawio-embed.js';

/** Write the `.drawio` XML back to disk (panel autosave / Ctrl+S). */
export async function saveDiagramXml(projectId: number, path: string, xml: string): Promise<void> {
  await apiCall('files.write', { projectId, path, content: xml });
}

/** Derive the image path: `diagrams/x.drawio` → `diagrams/x.svg` | `.png`. */
export function exportImagePath(drawioPath: string, format: DrawioExportFormat): string {
  return `${drawioPath.replace(/\.drawio$/i, '')}.${format}`;
}

/**
 * Persist an exported image (a `data:...;base64,…` URI) next to the `.drawio`
 * file. Returns the written path.
 */
export async function saveDiagramExport(
  projectId: number,
  drawioPath: string,
  dataUrl: string,
  format: DrawioExportFormat,
): Promise<string> {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const path = exportImagePath(drawioPath, format);
  await apiCall('files.write', { projectId, path, content: base64, encoding: 'base64' });
  return path;
}
