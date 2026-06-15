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

  function reactFiber(el) {
    for (var k in el) {
      if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) return el[k];
    }
    return null;
  }
  function reactInfo(el) {
    var f = reactFiber(el); if (!f) return null;
    var out = { framework: 'react', componentName: null, sourceFile: null, sourceLine: null };
    var cur = f, hops = 0;
    while (cur && hops < 40) {
      if (!out.sourceFile) {
        var src = cur._debugSource ||
          (cur.memoizedProps && cur.memoizedProps.__source) ||
          (cur.pendingProps && cur.pendingProps.__source);
        if (src && src.fileName) { out.sourceFile = src.fileName; out.sourceLine = src.lineNumber || null; }
      }
      if (!out.componentName) {
        var t = cur.type;
        if (typeof t === 'function') out.componentName = t.displayName || t.name || null;
        else if (t && typeof t === 'object') out.componentName = t.displayName || t.name || null;
      }
      if (out.sourceFile && out.componentName) break;
      cur = cur.return; hops++;
    }
    return out;
  }
  function vueInfo(el) {
    var c = el.__vueParentComponent;
    if (!c) { var vn = el.__vnode || el._vnode; c = vn && vn.component; }
    if (!c) return null;
    var t = c.type || {};
    return { framework: 'vue', componentName: t.__name || t.name || null, sourceFile: t.__file || null, sourceLine: null };
  }
  function angularInfo(el) {
    var ng = window.ng;
    try {
      var inst = ng && ((ng.getComponent && ng.getComponent(el)) || (ng.getOwningComponent && ng.getOwningComponent(el)));
      if (!inst) return el.__ngContext__ ? { framework: 'angular', componentName: null, sourceFile: null, sourceLine: null } : null;
      var ctor = inst.constructor || {};
      return { framework: 'angular', componentName: ctor.name || null, sourceFile: null, sourceLine: null };
    } catch (e) { return null; }
  }
  function detect(el) {
    try { var r = reactInfo(el); if (r) return r; } catch (e) {}
    try { var v = vueInfo(el); if (v) return v; } catch (e) {}
    try { var a = angularInfo(el); if (a) return a; } catch (e) {}
    return { framework: 'unknown', componentName: null, sourceFile: null, sourceLine: null };
  }

  function targetOf(e) {
    // Ignore our own overlay + the floating control bar (whose host carries
    // data-mcp-toolbar). composedPath() surfaces the shadow host so toolbar
    // clicks/hovers are never captured as selections (works even when armed).
    var path = (e.composedPath && e.composedPath()) || [];
    for (var i = 0; i < path.length; i++) {
      var n = path[i];
      if (n && n.getAttribute && (n.getAttribute('data-mcp-toolbar') != null || n.getAttribute('data-mcp-overlay') != null)) return null;
    }
    var el = e.target;
    return (el && el.nodeType === 1) ? el : null;
  }
  function onMove(e) {
    if (!armed) return;
    var el = targetOf(e); if (!el) { hideOverlay(); return; }
    drawOverlay(rectOf(el));
  }
  function onClick(e) {
    if (!armed) return;
    var el = targetOf(e); if (!el) return;
    e.preventDefault(); e.stopPropagation();
    var r = rectOf(el);
    var info = detect(el);
    var classes = ((el.getAttribute && el.getAttribute('class')) || '').split(/\s+/).filter(Boolean);
    var testId = (el.getAttribute && el.getAttribute('data-testid')) || el.id || '';
    // Ctrl (Win/Linux) / Cmd (Mac) → add to the selection set instead of
    // replacing it, so the user can cite several elements in one message.
    var additive = !!(e.ctrlKey || e.metaKey);
    var payload = {
      type: 'mcp:select',
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
      testId: testId || undefined,
      additive: additive || undefined,
    };
    try { window.__mcpSelect(JSON.stringify(payload)); } catch (e) {}
    hideOverlay();
  }
  function onKey(e) { if (e.key === 'Escape') { armed = false; hideOverlay(); } }

  window.__mcpArm = function () { armed = true; };
  window.__mcpDisarm = function () { armed = false; hideOverlay(); };
  // Used by the floating control bar's Inspect toggle (returns the new state).
  window.__mcpToggleInspect = function () { armed = !armed; if (!armed) hideOverlay(); return armed; };
  window.__mcpIsArmed = function () { return armed; };
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
})();
`;
