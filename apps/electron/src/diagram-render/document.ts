/** Only the embedded editor can satisfy the export acknowledgement. The host
 * supplies XML as an executeJavaScript argument, never as HTML or source. */
export const DIAGRAM_RENDER_DOCUMENT = `<!doctype html><html><body style="margin:0">
<script>
let readyResolve; const ready = new Promise(resolve => { readyResolve = resolve; });
let pending;
window.addEventListener('message', event => {
  const frame = document.getElementById('editor');
  if (event.source !== frame?.contentWindow || typeof event.data !== 'string') return;
  let message; try { message = JSON.parse(event.data); } catch { return; }
  if (message.event === 'init') readyResolve();
  if (!pending) return;
  if (message.event === 'load') {
    pending.phase = pending.format === 'png' ? 'bounds' : 'image';
    frame.contentWindow.postMessage(JSON.stringify({ action: 'export', format: pending.format === 'png' ? 'svg' : 'xmlsvg',
      embedImages: true, border: 10 }), '*');
  } else if (message.event === 'export') {
    if (pending.phase === 'bounds') {
      try {
        if (typeof message.data !== 'string' || message.data.length > 12 * 1024 * 1024 || !message.data.startsWith('data:image/svg+xml;base64,')) throw new Error('Invalid diagram bounds image');
        const svg = new DOMParser().parseFromString(atob(message.data.slice(message.data.indexOf(',') + 1)), 'image/svg+xml').documentElement;
        const width = parseFloat(svg.getAttribute('width')), height = parseFloat(svg.getAttribute('height'));
        if (![width, height].every(v => Number.isFinite(v) && v > 0 && v < 100000000)) throw new Error('Invalid diagram image dimensions');
        pending.phase = 'image';
        frame.contentWindow.postMessage(JSON.stringify({ action: 'export', format: 'xmlpng', embedImages: true,
          scale: Math.min(1, 2000 / width, 2000 / height), border: 10 }), '*');
      } catch (error) { const current = pending; pending = null; current.reject(error); }
      return;
    }
    const current = pending; pending = null;
    if (typeof message.data !== 'string' || message.data.length > 12 * 1024 * 1024) current.reject(new Error('Invalid or oversized diagram export'));
    else current.resolve(message.data);
  } else if (message.event === 'error') { const current = pending; pending = null; current.reject(new Error('Diagram render failed')); }
});
window.__diagramRender = async (xml, format) => {
  await ready;
  if (pending) throw new Error('Diagram render already pending');
  return new Promise((resolve, reject) => {
    pending = { resolve, reject, format };
    document.getElementById('editor').contentWindow.postMessage(JSON.stringify({ action: 'load', xml, autosave: 0, modified: 0 }), '*');
  });
};
</script>
<iframe id="editor" style="width:1024px;height:768px;border:0" src="mcp://diagram-render/drawio/index.html?embed=1&proto=json&offline=1&pwa=0&local=1&spin=0&libraries=0&noSaveBtn=1&noExitBtn=1&ui=min"></iframe>
</body></html>`;
