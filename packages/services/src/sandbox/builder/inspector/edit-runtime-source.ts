/**
 * Source of the visual-edit runtime that runs inside the preview app,
 * alongside the selection inspector. Handles the optimistic half of
 * two-way editing:
 *
 *   - `mcp:set-classes`     → swap the class list on every node stamped
 *                             with that loc (instant feedback; the server
 *                             rewrite lands ~300ms later via HMR).
 *   - `mcp:begin-text-edit` → contenteditable on the first stamped node;
 *                             Enter/blur commits (`mcp:text-committed`),
 *                             Escape restores the original text.
 *   - `mcp:set-css-vars`    → live theme preview on documentElement.
 *   - `mcp:query-loc`       → reply with how many nodes share the stamp
 *                             (drives the "edits all N instances" hint).
 *
 * Written as a string because it is compiled into the preview's Vite app,
 * not this package. Wired by react-stamp.ts into src/mcp-inspector.ts.
 */
export const EDIT_RUNTIME_SOURCE = String.raw`// MCP Builder visual-edit runtime.
function initMcpVisualEdit(post) {
  function nodesFor(loc) {
    try {
      return Array.prototype.slice.call(
        document.querySelectorAll('[data-mcp-loc="' + (window.CSS && CSS.escape ? CSS.escape(loc) : loc) + '"]'),
      );
    } catch (e) { return []; }
  }

  var editing = null; // { el, original, onKey, onBlur }

  function endTextEdit(commit) {
    if (!editing) return;
    var el = editing.el;
    el.removeEventListener('keydown', editing.onKey, true);
    el.removeEventListener('blur', editing.onBlur, true);
    el.contentEditable = 'false';
    el.style.outline = editing.outline;
    var text = (el.textContent || '').trim();
    if (commit && text !== editing.original.trim()) {
      post({ type: 'mcp:text-committed', loc: editing.loc, text: text, ts: Date.now() });
    } else if (!commit) {
      el.textContent = editing.original;
    }
    editing = null;
  }

  function beginTextEdit(loc) {
    endTextEdit(false);
    var el = nodesFor(loc)[0];
    if (!el) return;
    var original = el.textContent || '';
    var onKey = function (e) {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); el.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endTextEdit(false); }
    };
    var onBlur = function () { endTextEdit(true); };
    editing = { el: el, loc: loc, original: original, onKey: onKey, onBlur: onBlur, outline: el.style.outline };
    el.contentEditable = 'plaintext-only' in document.createElement('span') ? 'plaintext-only' : 'true';
    el.style.outline = '2px dashed #6366f1';
    el.addEventListener('keydown', onKey, true);
    el.addEventListener('blur', onBlur, true);
    el.focus();
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* selection is best-effort */ }
  }

  window.addEventListener('message', function (ev) {
    var d = ev && ev.data;
    if (!d || typeof d.type !== 'string') return;
    if (d.type === 'mcp:set-classes' && typeof d.loc === 'string' && Array.isArray(d.classes)) {
      nodesFor(d.loc).forEach(function (el) { el.className = d.classes.join(' '); });
    } else if (d.type === 'mcp:begin-text-edit' && typeof d.loc === 'string') {
      beginTextEdit(d.loc);
    } else if (d.type === 'mcp:set-css-vars' && d.vars && typeof d.vars === 'object') {
      Object.keys(d.vars).forEach(function (k) {
        try { document.documentElement.style.setProperty(k, String(d.vars[k])); } catch (e) {}
      });
    } else if (d.type === 'mcp:query-loc' && typeof d.loc === 'string') {
      post({ type: 'mcp:loc-count', loc: d.loc, count: nodesFor(d.loc).length });
    }
  });
}
`;
