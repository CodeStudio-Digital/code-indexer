/**
 * The `window.mcp` shim injected (as a <script>) into every plugin webview's
 * srcDoc. It's a plain-JS string because it runs INSIDE the sandboxed,
 * null-origin iframe — not in the host bundle. It speaks the postMessage
 * protocol the host `webview-bridge` understands: `{ __mcpPlugin:'invoke', id,
 * method, payload }` out, `{ __mcpPlugin:'result', id, ok, result|error }` back.
 *
 * The shim NEVER sends a namespace — the host bridge binds every call to the
 * frame's own plugin namespace (a null-origin frame can't be trusted to declare
 * who it is). `window.__pluginContext` ({ namespace, projectId }) is injected
 * separately by WebviewWindow before this script runs.
 */
export const PLUGIN_IFRAME_RUNTIME = `(function () {
  var seq = 0;
  var pending = {};
  var streams = {};
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d) return;
    if (d.__mcpPlugin === 'result') {
      var p = pending[d.id];
      if (!p) return;
      delete pending[d.id];
      if (d.ok) p.resolve(d.result);
      else p.reject(new Error(d.error || 'plugin call failed'));
    } else if (d.__mcpPlugin === 'stream') {
      var s = streams[d.id];
      if (!s) return;
      if (d.event === 'data') { try { s.onData(d.value); } catch (_) {} }
      else { if (d.event === 'error' && s.onError) { try { s.onError(d.error); } catch (_) {} }
             delete streams[d.id]; if (s.onEnd) { try { s.onEnd(); } catch (_) {} } }
    }
  });
  function call(method, payload) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      parent.postMessage({ __mcpPlugin: 'invoke', id: id, method: method, payload: payload || {} }, '*');
    });
  }
  function openStream(method, payload, handlers) {
    var id = ++seq;
    streams[id] = handlers || {};
    parent.postMessage({ __mcpPlugin: 'openStream', id: id, method: method, payload: payload || {} }, '*');
    return function close() {
      if (streams[id]) { delete streams[id]; parent.postMessage({ __mcpPlugin: 'closeStream', id: id }, '*'); }
    };
  }
  window.mcp = {
    context: window.__pluginContext || {},
    invokeTool: function (tool, args) { return call('plugins.invokeTool', { tool: tool, args: args || {} }); },
    getPermissions: function () { return call('plugins.getPermissions', {}); },
    storage: {
      get: function (key) { return call('plugins.storageGet', { key: key }).then(function (r) { return r.value; }); },
      set: function (key, value) { return call('plugins.storageSet', { key: key, value: value }); },
      list: function () { return call('plugins.storageList', {}).then(function (r) { return r.keys; }); }
    },
    /** Stream a long-running command. handlers: { onData(chunk), onEnd(), onError(msg) }. Returns close(). */
    execStream: function (cmd, args, handlers) { return openStream('plugins.execStream', { cmd: cmd, args: args || [] }, handlers); },
    listPlugins: function () { return call('plugins.list'); },
    readFile: function (path) { return call('files.read', { path: path }); }
  };
})();`;

/** Build the <head> injection (context + theme + shim) prepended to a plugin's HTML. */
export function buildIframeInjection(
  context: { namespace: string; projectId?: number },
  themeTokens: Record<string, string>,
): string {
  const vars = Object.entries(themeTokens)
    .map(([k, v]) => `${k}: ${v};`)
    .join(' ');
  return [
    `<script>window.__pluginContext = ${JSON.stringify(context)};<\/script>`,
    `<style>:root { ${vars} } html,body { margin:0; background: var(--background); color: var(--foreground); font-family: var(--font-sans, system-ui); }<\/style>`,
    `<script>${PLUGIN_IFRAME_RUNTIME}<\/script>`,
  ].join('\n');
}

/** Splice the injection into a plugin's HTML (before </head>, else prepend). */
export function injectIntoHtml(
  html: string,
  context: { namespace: string; projectId?: number },
  themeTokens: Record<string, string>,
): string {
  const injection = buildIframeInjection(context, themeTokens);
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${injection}\n</head>`);
  return `${injection}\n${html}`;
}
