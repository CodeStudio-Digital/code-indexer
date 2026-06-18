/**
 * Runtime framework detection for the universal CDP inspector, split out of
 * `universal-inspector-source.ts` to keep that module focused (and under the
 * LOC budget). Injected as bare global function declarations BEFORE the
 * inspector IIFE — which calls `mcpDetectFramework(el)` on hover/click — exactly
 * like the region helpers. It runs inside the previewed app, so it's a string.
 *
 * React-first and resilient to modern React/Next:
 *   - React 19 removed fiber `_debugSource`, and the automatic JSX dev runtime
 *     does NOT put `__source` on props — so source file:line is best-effort, but
 *     the COMPONENT NAME is resolved reliably by walking `fiber.return` to the
 *     nearest function/class component (unwrapping memo/forwardRef).
 *   - App Router Server Components have NO client fiber on their DOM nodes, so
 *     when the clicked node carries no fiber we walk DOM ancestors to the
 *     nearest element that does and report that component as APPROXIMATE
 *     (`componentApprox`) instead of bailing to a CSS-only "unknown" descriptor.
 *   - `window.__mcpSelectorMode` ('react' | 'universal', injected by the host):
 *     in 'react' the page is treated as React whenever React is present, even
 *     for fiberless nodes; 'universal' keeps the react→vue→angular→css order.
 *
 * NOTE: no template literals inside — keep it plain string concatenation so the
 * outer `String.raw` never trips over a backtick.
 */
export const REACT_DETECT_SOURCE = String.raw`
function mcpReactFiber(el) {
  for (var k in el) {
    if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) return el[k];
  }
  return null;
}
// React 19-safe component name: skip host strings, unwrap memo/forwardRef. Depth
// guard (d>8) bounds the t.type recursion — the inspector runs in arbitrary apps,
// so a cyclic/exotic type object must never blow the stack. (No backticks: String.raw.)
function mcpNameFromType(t, d) {
  if (!t || (d | 0) > 8) return null;
  if (typeof t === 'string') return null;            // host element (div/span/…)
  if (typeof t === 'function') return t.displayName || t.name || null;
  if (typeof t === 'object') {
    if (t.displayName) return t.displayName;
    if (t.type) return mcpNameFromType(t.type, (d | 0) + 1);  // React.memo(Inner)
    if (t.render) return t.render.displayName || t.render.name || null; // forwardRef
    return t.name || null;
  }
  return null;
}
// Walk a fiber up to the nearest named component + best-effort source loc.
function mcpReactInfoFrom(fiber, approx) {
  var out = { framework: 'react', componentName: null, sourceFile: null, sourceLine: null, componentApprox: !!approx };
  var cur = fiber, hops = 0;
  while (cur && hops < 60) {
    if (!out.sourceFile) {
      var src = cur._debugSource ||
        (cur.memoizedProps && cur.memoizedProps.__source) ||
        (cur.pendingProps && cur.pendingProps.__source);
      if (src && src.fileName) { out.sourceFile = src.fileName; out.sourceLine = src.lineNumber || null; }
    }
    if (!out.componentName) { var n = mcpNameFromType(cur.type); if (n) out.componentName = n; }
    if (out.sourceFile && out.componentName) break;
    cur = cur.return; hops++;
  }
  return out;
}
// Nearest DOM ancestor carrying a React fiber (Server-Component fallback).
function mcpNearestReactEl(el) {
  var cur = el, hops = 0;
  while (cur && cur.nodeType === 1 && hops < 25) {
    if (mcpReactFiber(cur)) return cur;
    cur = cur.parentElement; hops++;
  }
  return null;
}
function mcpReactInfo(el) {
  var f = mcpReactFiber(el);
  if (f) return mcpReactInfoFrom(f, false);
  var host = mcpNearestReactEl(el);
  if (host) return mcpReactInfoFrom(mcpReactFiber(host), true);
  return null;
}
// Is the page React at all? Dev builds install the DevTools hook (Next dev does);
// otherwise look for a fiber on a few likely roots. Cheap, best-effort.
function mcpPageHasReact() {
  try {
    var hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (hook && hook.renderers && (hook.renderers.size > 0 || Object.keys(hook.renderers).length > 0)) return true;
  } catch (e) {}
  var roots = [document.getElementById('__next'), document.getElementById('root'), document.body];
  for (var i = 0; i < roots.length; i++) { if (roots[i] && mcpReactFiber(roots[i])) return true; }
  return false;
}
function mcpVueInfo(el) {
  var c = el.__vueParentComponent;
  if (!c) { var vn = el.__vnode || el._vnode; c = vn && vn.component; }
  if (!c) return null;
  var t = c.type || {};
  return { framework: 'vue', componentName: t.__name || t.name || null, sourceFile: t.__file || null, sourceLine: null, componentApprox: false };
}
function mcpAngularInfo(el) {
  var ng = window.ng;
  try {
    var inst = ng && ((ng.getComponent && ng.getComponent(el)) || (ng.getOwningComponent && ng.getOwningComponent(el)));
    if (!inst) return el.__ngContext__ ? { framework: 'angular', componentName: null, sourceFile: null, sourceLine: null, componentApprox: false } : null;
    var ctor = inst.constructor || {};
    return { framework: 'angular', componentName: ctor.name || null, sourceFile: null, sourceLine: null, componentApprox: false };
  } catch (e) { return null; }
}
// Element → framework descriptor. Honors window.__mcpSelectorMode.
function mcpDetectFramework(el) {
  var mode = (typeof window !== 'undefined' && window.__mcpSelectorMode) || 'auto';
  try { var r = mcpReactInfo(el); if (r) return r; } catch (e) {}
  if (mode === 'react') {
    try { if (mcpPageHasReact()) return { framework: 'react', componentName: null, sourceFile: null, sourceLine: null, componentApprox: true }; } catch (e) {}
  }
  try { var v = mcpVueInfo(el); if (v) return v; } catch (e) {}
  try { var a = mcpAngularInfo(el); if (a) return a; } catch (e) {}
  return { framework: 'unknown', componentName: null, sourceFile: null, sourceLine: null, componentApprox: false };
}
`;
