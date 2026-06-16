/**
 * Shared marquee/region helpers, concatenated into BOTH preview inspectors
 * (the inline `data-mcp-loc` one and the universal CDP one). Written as a
 * string fragment because it runs inside the previewed app, like the
 * inspectors themselves.
 *
 * Two concerns:
 *   - a dashed rubber-band overlay drawn while the user drags;
 *   - `mcpCollectRegion(region, { all, describe })` — turn a drawn box into a
 *     tidy, "component-level" set of element descriptors.
 *
 * Why geometric collapse (not `data-mcp-name`): the stamp puts the ENCLOSING
 * component name on every element (not just roots), so it can't mark roots.
 * Instead we keep the OUTERMOST elements FULLY CONTAINED in the box — exactly
 * the complete blocks the user drew around, never the section that spills
 * outside it nor the inner guts whose contained ancestor is already kept.
 * Falls back to "center-in-box, outermost" when nothing fits fully (partial
 * drag) so a marquee always returns something.
 */
export const REGION_HELPERS_SOURCE = String.raw`// MCP region/marquee helpers (shared by both inspectors).
function mcpEnsureMarquee() {
  if (window.__mcpMarqueeEl && window.__mcpMarqueeEl.isConnected) return window.__mcpMarqueeEl;
  var d = document.createElement('div');
  d.setAttribute('data-mcp-marquee', '');
  var s = d.style;
  s.position = 'fixed'; s.zIndex = '2147483647'; s.pointerEvents = 'none';
  s.border = '2px dashed #6366f1'; s.background = 'rgba(99,102,241,0.10)';
  s.borderRadius = '4px'; s.display = 'none'; s.top = '0'; s.left = '0';
  document.documentElement.appendChild(d);
  window.__mcpMarqueeEl = d;
  return d;
}
function mcpDrawMarquee(x, y, w, h) {
  var o = mcpEnsureMarquee();
  o.style.display = 'block';
  o.style.left = x + 'px'; o.style.top = y + 'px';
  o.style.width = w + 'px'; o.style.height = h + 'px';
}
function mcpHideMarquee() { if (window.__mcpMarqueeEl) window.__mcpMarqueeEl.style.display = 'none'; }

/** Rect from two drag points (clamped to non-negative size). */
function mcpRegionFromPoints(x0, y0, x1, y1) {
  var x = Math.min(x0, x1), y = Math.min(y0, y1);
  return { x: x, y: y, width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

function mcpHasAncestorIn(el, set) {
  var cur = el.parentElement;
  while (cur && cur.nodeType === 1) {
    if (set.has(cur)) return true;
    if (cur === document.body) break;
    cur = cur.parentElement;
  }
  return false;
}

/**
 * Collect a "component-level, collapsed" descriptor set for the drawn box.
 *   region   = { x, y, width, height } in VIEWPORT coords.
 *   opts.all = () => iterable of candidate elements.
 *   opts.describe = (el) => payload | null (loc/componentName/tag/classes/text/rect/…).
 * Returns an array of payloads (deduped by loc|selector|tag+text, capped at 12).
 */
function mcpCollectRegion(region, opts) {
  var tol = 2;
  var rx2 = region.x + region.width, ry2 = region.y + region.height;
  var cand = [];
  var list = opts.all(), i = 0;
  for (i = 0; i < list.length && i < 4000; i++) {
    var el = list[i];
    if (!el || el.nodeType !== 1 || el.hasAttribute('data-mcp-marquee') || el.hasAttribute('data-mcp-overlay')) continue;
    var r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    cand.push({ el: el, r: r });
  }
  function fullyContained(r) {
    return r.left >= region.x - tol && r.top >= region.y - tol && r.right <= rx2 + tol && r.bottom <= ry2 + tol;
  }
  function centerInside(r) {
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    return cx >= region.x && cx <= rx2 && cy >= region.y && cy <= ry2;
  }
  var primary = cand.filter(function (c) { return fullyContained(c.r); });
  var picked = primary.length ? primary : cand.filter(function (c) { return centerInside(c.r); });
  // Keep outermost: drop an element whose ancestor is also in the picked set.
  var setEl = new Set(picked.map(function (c) { return c.el; }));
  var outer = picked.filter(function (c) { return !mcpHasAncestorIn(c.el, setEl); });
  var out = [], seen = {};
  for (i = 0; i < outer.length; i++) {
    var d = opts.describe(outer[i].el);
    if (!d) continue;
    var k = d.loc || d.selector || (d.tag + '|' + d.text);
    if (seen[k]) continue;
    seen[k] = 1;
    out.push(d);
    if (out.length >= 12) break;
  }
  return out;
}
`;
