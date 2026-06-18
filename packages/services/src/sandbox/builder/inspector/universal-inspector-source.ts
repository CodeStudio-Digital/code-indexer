/**
 * Framework-AGNOSTIC element-selection inspector, injected at RUNTIME (via the
 * Electron CDP preview window — `Page.addScriptToEvaluateOnNewDocument` +
 * `Runtime.evaluate`) into ANY running app, including ones CodeStudio did not
 * scaffold (Angular, Next/OpenNext, React, Vue, …). Unlike the inline builder
 * inspector (`runtime-source.ts`), it needs NO `data-mcp-loc` stamp: on click it
 * builds a descriptor from the live DOM + each framework's dev metadata and
 * sends it back through the CDP binding `window.__mcpSelect(json)` (the window
 * is top-level, so there is no parent to postMessage to).
 *
 * Source citation is best-effort per framework:
 *   - React/Next → fiber `_debugSource` / props `__source` (often exact file:line)
 *                  + nearest component `displayName`/`name`.
 *   - Vue        → `el.__vueParentComponent.type.__file` + component name.
 *   - Angular    → `window.ng.getComponent/getOwningComponent(el).constructor.name`
 *                  (dev templates compile to Ivy — component-level, no file:line).
 * Everything is wrapped in try/catch and falls back to a robust CSS selector +
 * tag/classes/text so the model can always locate the element.
 *
 * Emitted payload matches the `mcp:select` shape (so the dashboard funnels it
 * through the same `setSelected` / `consumeSelectionPrefix` path as the inline
 * builder). Written as a string because it runs inside the previewed app.
 */
export const UNIVERSAL_INSPECTOR_SOURCE = String.raw`(function () {
  if (window.__mcpInspectorInstalled) return;
  window.__mcpInspectorInstalled = true;
  // Default DISARMED: the window opens in "navigate" mode so the user can click
  // menus/routes; the dashboard (or the floating bar) arms it when ready.
  var armed = false;
  var overlay = null;
  // Region/marquee mode (drag a box → cite every element inside it + screenshot).
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
  function drawOverlay(r) {
    var o = ensureOverlay();
    o.style.display = 'block';
    o.style.top = r.top + 'px'; o.style.left = r.left + 'px';
    o.style.width = r.width + 'px'; o.style.height = r.height + 'px';
  }
  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, left: r.left };
  }

  function cssSelector(el) {
    try {
      if (!el || el.nodeType !== 1) return '';
      var esc = (window.CSS && CSS.escape) ? CSS.escape : function (v) { return v; };
      var parts = [], cur = el, depth = 0;
      while (cur && cur.nodeType === 1 && cur !== document.body && depth < 6) {
        if (cur.id) { parts.unshift('#' + esc(cur.id)); break; }
        var sel = cur.tagName.toLowerCase();
        var par = cur.parentElement;
        if (par) {
          var same = Array.prototype.filter.call(par.children, function (c) { return c.tagName === cur.tagName; });
          if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
        }
        parts.unshift(sel); cur = par; depth++;
      }
      return parts.join('>');
    } catch (e) { return ''; }
  }

  // Framework detection (React/Vue/Angular) lives in REACT_DETECT_SOURCE,
  // injected as globals just before this IIFE — mcpDetectFramework(el) is the
  // entry point. Kept separate so React 19 / Server-Component handling can grow
  // without inflating this file. (No backticks here: this is inside String.raw.)

  // True when the event happens on the floating control bar (shadow host carries
  // data-mcp-toolbar). The region handlers MUST let these through, otherwise the
  // capture-phase swallow eats the bar's own buttons — including the toggle that
  // turns region mode back OFF (you'd get stuck armed forever).
  function inToolbar(e) {
    var path = (e.composedPath && e.composedPath()) || [];
    for (var i = 0; i < path.length; i++) {
      var n = path[i];
      if (n && n.getAttribute && n.getAttribute('data-mcp-toolbar') != null) return true;
    }
    return false;
  }
  function targetOf(e) {
    // Ignore our own overlay + the floating control bar (whose host carries
    // data-mcp-toolbar). composedPath() surfaces the shadow host so toolbar
    // clicks/hovers are never captured as selections (works even when armed).
    var path = (e.composedPath && e.composedPath()) || [];
    for (var i = 0; i < path.length; i++) {
      var n = path[i];
      if (n && n.getAttribute && (n.getAttribute('data-mcp-toolbar') != null || n.getAttribute('data-mcp-overlay') != null || n.getAttribute('data-mcp-marquee') != null)) return null;
    }
    var el = e.target;
    return (el && el.nodeType === 1) ? el : null;
  }
  // Element to descriptor (everything but type/additive). Shared by the
  // single-click path and the region/marquee path.
  function buildPayload(el) {
    var r = rectOf(el);
    var info = mcpDetectFramework(el);
    var classes = ((el.getAttribute && el.getAttribute('class')) || '').split(/\s+/).filter(Boolean);
    var testId = (el.getAttribute && el.getAttribute('data-testid')) || el.id || '';
    return {
      loc: info.sourceFile ? (info.sourceFile + (info.sourceLine ? ':' + info.sourceLine : '')) : '',
      componentName: info.componentName || null,
      tag: (el.tagName || '').toLowerCase(),
      classes: classes,
      text: (el.textContent || '').trim().slice(0, 120),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      framework: info.framework || 'unknown',
      selector: cssSelector(el),
      sourceFile: info.sourceFile || undefined,
      sourceLine: info.sourceLine || undefined,
      componentApprox: info.componentApprox || undefined,
      testId: testId || undefined,
    };
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
    var el = targetOf(e); if (!el) { hideOverlay(); return; }
    drawOverlay(rectOf(el));
  }
  function onClick(e) {
    if (regionArmed) {
      if (inToolbar(e)) return; // let the floating bar (incl. the region toggle) work
      e.preventDefault(); e.stopPropagation(); return;
    }
    if (!armed) return;
    var el = targetOf(e); if (!el) return;
    e.preventDefault(); e.stopPropagation();
    var payload = buildPayload(el);
    payload.type = 'mcp:select';
    // Ctrl (Win/Linux) / Cmd (Mac) → add to the selection set instead of
    // replacing it, so the user can cite several elements in one message.
    payload.additive = (!!(e.ctrlKey || e.metaKey)) || undefined;
    try { window.__mcpSelect(JSON.stringify(payload)); } catch (e2) {}
    hideOverlay();
  }
  // ── Region/marquee selection ──────────────────────────────────────
  function onDown(e) {
    if (!regionArmed || inToolbar(e)) return; // never start a drag on the toolbar
    e.preventDefault(); e.stopPropagation();
    dragging = true;
    dragStart = { x: e.clientX, y: e.clientY };
    mcpDrawMarquee(e.clientX, e.clientY, 0, 0);
  }
  function onUp(e) {
    if (!regionArmed || !dragging) return;
    dragging = false;
    e.preventDefault(); e.stopPropagation();
    var rg = mcpRegionFromPoints(dragStart.x, dragStart.y, e.clientX, e.clientY);
    if (rg.width < 6 || rg.height < 6) { mcpHideMarquee(); return; }
    var sels = mcpCollectRegion(rg, {
      all: function () { return document.querySelectorAll('*'); },
      describe: function (el) {
        if (el.getAttribute && el.getAttribute('data-mcp-toolbar') != null) return null;
        return buildPayload(el);
      },
    });
    hideOverlay(); mcpHideMarquee();
    requestAnimationFrame(function () {
      try { window.__mcpRegionSelect(JSON.stringify({ type: 'mcp:region-select', selections: sels, rect: rg, dpr: window.devicePixelRatio || 1 })); } catch (e2) {}
    });
  }
  function onKey(e) {
    if (e.key !== 'Escape') return;
    if (regionArmed) { dragging = false; mcpHideMarquee(); }
    else { armed = false; hideOverlay(); }
  }

  window.__mcpArm = function () { armed = true; regionArmed = false; mcpHideMarquee(); };
  window.__mcpDisarm = function () { armed = false; regionArmed = false; dragging = false; hideOverlay(); mcpHideMarquee(); };
  // Used by the floating control bar's Inspect toggle (returns the new state).
  window.__mcpToggleInspect = function () { armed = !armed; if (armed) { regionArmed = false; mcpHideMarquee(); } else hideOverlay(); return armed; };
  window.__mcpIsArmed = function () { return armed; };
  // Region toggle (floating-bar "Select region").
  window.__mcpArmRegion = function () { regionArmed = true; armed = false; hideOverlay(); };
  window.__mcpToggleRegion = function () { regionArmed = !regionArmed; if (regionArmed) { armed = false; hideOverlay(); } else { dragging = false; mcpHideMarquee(); } return regionArmed; };
  window.__mcpIsRegionArmed = function () { return regionArmed; };
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('mouseup', onUp, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
})();
`;
