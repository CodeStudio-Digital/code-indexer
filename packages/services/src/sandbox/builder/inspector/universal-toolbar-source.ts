/**
 * Floating control bar injected into the CDP preview window alongside the
 * universal inspector. Lives in an isolated Shadow DOM (so the app's CSS can't
 * touch it and the inspector ignores it via the `data-mcp-toolbar` host guard).
 *
 * In-page actions (no round trip): Inspect ON/OFF (toggles the inspector's
 * `armed` via `window.__mcpToggleInspect`), reload, back/forward. Window-level
 * actions go to the main process through the `window.__mcpControl` CDP binding:
 * device widths (`viewport:<preset>`) and `close`. The bar is draggable by its
 * grip so it never permanently covers the app's own header.
 *
 * Written as a string because it runs inside the previewed app (injected via
 * `Page.addScriptToEvaluateOnNewDocument` + `Runtime.evaluate`).
 */
export const UNIVERSAL_TOOLBAR_SOURCE = String.raw`(function () {
  if (window.__mcpToolbarInstalled) return;
  window.__mcpToolbarInstalled = true;

  function build() {
    var mount = document.body || document.documentElement;
    if (!mount) return;
    var host = document.createElement('div');
    host.setAttribute('data-mcp-toolbar', '');
    var hs = host.style;
    hs.position = 'fixed'; hs.zIndex = '2147483647'; hs.top = '10px';
    hs.left = '50%'; hs.transform = 'translateX(-50%)';
    mount.appendChild(host);
    var root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.bar{display:flex;align-items:center;gap:2px;font:500 12px/1 system-ui,sans-serif;' +
      'background:#0b1020e6;color:#e5e7eb;border:1px solid #2a3350;border-radius:10px;' +
      'padding:4px;box-shadow:0 6px 24px rgba(0,0,0,.45);backdrop-filter:blur(6px)}' +
      '.grip{cursor:grab;color:#64748b;padding:0 4px;user-select:none}' +
      '.sep{width:1px;height:18px;background:#2a3350;margin:0 2px}' +
      'button{all:unset;cursor:pointer;color:#cbd5e1;padding:5px 8px;border-radius:7px;' +
      'display:inline-flex;align-items:center;gap:5px}' +
      'button:hover{background:#1e2540;color:#fff}' +
      '#insp.on{background:#6366f1;color:#fff}' +
      '.dot{width:7px;height:7px;border-radius:50%;background:#64748b;display:inline-block}' +
      '#insp.on .dot{background:#fff;box-shadow:0 0 6px #fff}' +
      '</style>' +
      '<div class="bar">' +
      '<span class="grip" id="grip">⁙</span>' +
      '<button id="insp"><span class="dot"></span><span id="insplbl">Inspect</span></button>' +
      '<span class="sep"></span>' +
      '<button id="back" title="Back">‹</button>' +
      '<button id="fwd" title="Forward">›</button>' +
      '<button id="reload" title="Reload">↻</button>' +
      '<span class="sep"></span>' +
      '<button id="vd" title="Desktop">▭</button>' +
      '<button id="vt" title="Tablet">▯</button>' +
      '<button id="vm" title="Mobile">❙</button>' +
      '<span class="sep"></span>' +
      '<button id="close" title="Close preview window">✕</button>' +
      '</div>';

    var $ = function (id) { return root.getElementById(id); };
    function refresh() {
      var on = !!(window.__mcpIsArmed && window.__mcpIsArmed());
      var b = $('insp'); if (b) b.className = on ? 'on' : '';
      var l = $('insplbl'); if (l) l.textContent = on ? 'Inspecting' : 'Inspect';
    }
    $('insp').onclick = function () { try { window.__mcpToggleInspect && window.__mcpToggleInspect(); } catch (e) {} refresh(); };
    $('reload').onclick = function () { try { location.reload(); } catch (e) {} };
    $('back').onclick = function () { try { history.back(); } catch (e) {} };
    $('fwd').onclick = function () { try { history.forward(); } catch (e) {} };
    function ctrl(c) { return function () { try { window.__mcpControl && window.__mcpControl(c); } catch (e) {} }; }
    $('vd').onclick = ctrl('viewport:desktop');
    $('vt').onclick = ctrl('viewport:tablet');
    $('vm').onclick = ctrl('viewport:mobile');
    $('close').onclick = ctrl('close');
    refresh();

    // Drag by the grip so the bar can be moved off the app's own header.
    var drag = null;
    $('grip').addEventListener('mousedown', function (e) {
      var r = host.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      hs.transform = 'none'; e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!drag) return;
      hs.left = Math.max(0, e.clientX - drag.dx) + 'px';
      hs.top = Math.max(0, e.clientY - drag.dy) + 'px';
    }, true);
    window.addEventListener('mouseup', function () { drag = null; }, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
`;
