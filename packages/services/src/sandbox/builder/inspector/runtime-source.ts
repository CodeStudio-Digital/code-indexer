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
  // Region/marquee mode (drag a box → cite every stamped element inside it).
  var regionArmed = false;
  var dragging = false;
  var dragStart = { x: 0, y: 0 };

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
    if (regionArmed) {
      if (dragging) {
        var rg = mcpRegionFromPoints(dragStart.x, dragStart.y, e.clientX, e.clientY);
        mcpDrawMarquee(rg.x, rg.y, rg.width, rg.height);
      }
      return;
    }
    if (!armed) return;
    var el = stamped(e.target);
    if (!el) { hideOverlay(); return; }
    var r = rectOf(el);
    drawOverlay(r);
    post({ type: 'mcp:hover', loc: el.getAttribute('data-mcp-loc'), rect: { x: r.x, y: r.y, width: r.width, height: r.height } });
  }
  // ── Region/marquee selection ──────────────────────────────────────
  function onDown(e) {
    if (!regionArmed) return;
    e.preventDefault(); e.stopPropagation();
    dragging = true;
    dragStart = { x: e.clientX, y: e.clientY };
    mcpDrawMarquee(e.clientX, e.clientY, 0, 0);
  }
  function describeStamped(el) {
    var r = el.getBoundingClientRect();
    var classes = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    return {
      loc: el.getAttribute('data-mcp-loc') || '',
      componentName: el.getAttribute('data-mcp-name') || null,
      tag: el.tagName.toLowerCase(),
      classes: classes,
      text: (el.textContent || '').trim().slice(0, 120),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    };
  }
  function onUp(e) {
    if (!regionArmed || !dragging) return;
    dragging = false;
    e.preventDefault(); e.stopPropagation();
    var rg = mcpRegionFromPoints(dragStart.x, dragStart.y, e.clientX, e.clientY);
    if (rg.width < 6 || rg.height < 6) { mcpHideMarquee(); return; }
    var sels = mcpCollectRegion(rg, {
      all: function () { return document.querySelectorAll('[data-mcp-loc]'); },
      describe: describeStamped,
    });
    // Clear our overlays BEFORE the host screenshots the region, then wait a
    // paint so the dashed box never leaks into the capture.
    hideOverlay(); mcpHideMarquee();
    requestAnimationFrame(function () {
      post({ type: 'mcp:region-select', selections: sels, rect: rg, dpr: window.devicePixelRatio || 1 });
    });
  }
  function onClick(e) {
    if (regionArmed) { e.preventDefault(); e.stopPropagation(); return; }
    if (!armed) return;
    var el = stamped(e.target);
    if (!el) return;
    e.preventDefault(); e.stopPropagation();
    var r = rectOf(el);
    var classes = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    // Ctrl (Win/Linux) / Cmd (Mac) → add to the selection set instead of
    // replacing it, so the user can cite several elements in one message.
    var additive = !!(e.ctrlKey || e.metaKey);
    post({
      type: 'mcp:select',
      loc: el.getAttribute('data-mcp-loc'),
      componentName: el.getAttribute('data-mcp-name') || null,
      tag: el.tagName.toLowerCase(),
      classes: classes,
      text: (el.textContent || '').trim().slice(0, 120),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      additive: additive || undefined,
    });
  }
  function onKey(e) {
    if (e.key !== 'Escape') return;
    if (regionArmed) { dragging = false; mcpHideMarquee(); }
    else if (armed) { hideOverlay(); post({ type: 'mcp:clear' }); }
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('mouseup', onUp, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);

  window.addEventListener('message', function (ev) {
    var d = ev && ev.data;
    if (!d || typeof d.type !== 'string') return;
    if (d.type === 'mcp:arm') { armed = true; regionArmed = false; mcpHideMarquee(); }
    else if (d.type === 'mcp:arm-region') { regionArmed = true; armed = false; dragging = false; hideOverlay(); }
    else if (d.type === 'mcp:disarm') { armed = false; regionArmed = false; dragging = false; hideOverlay(); mcpHideMarquee(); }
  });
}
`;
