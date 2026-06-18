/**
 * Reliable client-side file download. The anchor is appended to the DOM and the
 * blob URL is revoked on a delay — a detached anchor or an immediate revoke can
 * make Electron/Chromium drop the download before it starts.
 */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadJson(filename: string, doc: unknown): void {
  downloadBlob(filename, new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
}
