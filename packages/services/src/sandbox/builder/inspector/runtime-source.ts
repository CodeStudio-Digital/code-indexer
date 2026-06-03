/**
 * Source of the element-selection inspector that runs inside the preview
 * app. Armed/disarmed by the dashboard via `mcp:arm` / `mcp:disarm`. While
 * armed: hovering draws a highlight overlay and emits `mcp:hover`; clicking
 * captures the nearest `data-mcp-loc` ancestor and emits `mcp:select`
 * (swallowing the click so the app doesn't navigate). `Escape` clears.
 *
 * Framework-agnostic: it only reads `data-mcp-loc`/`data-mcp-name` off the
 * rendered DOM. Written as a string because it is compiled into the
 * sandbox's Vite app, not this package.
 */
export const INSPECTOR_RUNTIME_SOURCE = String.raw`// MCP Builder element-selection inspector.
function initMcpInspector(post) {
  var armed = false;
  var overlay = null;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.setAttribute('data-mcp-overlay', '');
    var s = overlay.style;
    s.position = 'fixed'; s.zIndex = '2147483647'; s.pointerEvents = 'none';
    s.border = '2px solid #6366f1'; s.background = 'rgba(99,102,241,0.12)';
    s.borderRadius = '3px'; s.transition = 'all 60ms ease'; s.display = 'none';
    s.top = '0'; s.left = '0';
    document.documentElement.appendChild(overlay);
    return overlay;
  }
  function hideOverlay() { if (overlay) overlay.style.display = 'none'; }
  function drawOverlay(rect) {
    var o = ensureOverlay();
    o.style.display = 'block';
    o.style.top = rect.top + 'px'; o.style.left = rect.left + 'px';
    o.style.width = rect.width + 'px'; o.style.height = rect.height + 'px';
  }

  function stamped(el) {
    var cur = el;
    while (cur && cur !== document.body && cur.nodeType === 1) {
      if (cur.hasAttribute && cur.hasAttribute('data-mcp-loc')) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, left: r.left };
  }

  function onMove(e) {
    if (!armed) return;
    var el = stamped(e.target);
    if (!el) { hideOverlay(); return; }
    var r = rectOf(el);
    drawOverlay(r);
    post({ type: 'mcp:hover', loc: el.getAttribute('data-mcp-loc'), rect: { x: r.x, y: r.y, width: r.width, height: r.height } });
  }
  function onClick(e) {
    if (!armed) return;
    var el = stamped(e.target);
    if (!el) return;
    e.preventDefault(); e.stopPropagation();
    var r = rectOf(el);
    var classes = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    post({
      type: 'mcp:select',
      loc: el.getAttribute('data-mcp-loc'),
      componentName: el.getAttribute('data-mcp-name') || null,
      tag: el.tagName.toLowerCase(),
      classes: classes,
      text: (el.textContent || '').trim().slice(0, 120),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    });
  }
  function onKey(e) {
    if (e.key === 'Escape' && armed) { hideOverlay(); post({ type: 'mcp:clear' }); }
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);

  window.addEventListener('message', function (ev) {
    var d = ev && ev.data;
    if (!d || typeof d.type !== 'string') return;
    if (d.type === 'mcp:arm') { armed = true; }
    else if (d.type === 'mcp:disarm') { armed = false; hideOverlay(); }
  });
}
`;
