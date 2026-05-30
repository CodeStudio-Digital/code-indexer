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
    /** The scoped, tool-constrained LLM assistant for this plugin. */
    assistant: {
      /** [{ providerId, modelId, label, isDefault }] for a model picker. */
      listModels: function () { return call('plugins.listModels', {}); },
      /**
       * Start a chat turn. opts: { providerId, modelId, history }. handlers:
       * { onData(chunk), onEnd(), onError(msg) } where chunk is a
       * PluginAssistantChunk (text / tool_use / confirm_request / tool_result /
       * done). Returns close() to abort.
       */
      chat: function (message, opts, handlers) {
        opts = opts || {};
        return openStream('plugins.assistantStream', {
          message: message,
          providerId: opts.providerId,
          modelId: opts.modelId,
          history: opts.history || []
        }, handlers);
      },
      /** Approve/deny a paused mutating tool call (from a confirm_request chunk). */
      confirm: function (callId, approved) { return call('plugins.assistantConfirm', { callId: callId, approved: !!approved }); }
    },
    /**
     * Host-rendered dialogs + toasts. A sandboxed iframe can't use
     * window.confirm/alert/prompt (they silently no-op), so use these instead.
     * All return Promises. confirm → boolean; prompt → string|null; alert/toast
     * → void. Options use plugin-friendly names: { title, message, confirmText,
     * cancelText, danger } for confirm; add { defaultValue, placeholder } for
     * prompt; toast takes { kind:'info'|'success'|'error'|'warning', message }.
     */
    ui: {
      confirm: function (opts) { return call('plugins.ui.confirm', opts || {}); },
      prompt: function (opts) { return call('plugins.ui.prompt', opts || {}); },
      alert: function (opts) { return call('plugins.ui.alert', opts || {}); },
      toast: function (opts) { return call('plugins.ui.toast', opts || {}); }
    },
    /**
     * Internationalization. The host injects the active locale; the plugin
     * ships its OWN catalogs and builds a translator over them:
     *   var t = mcp.i18n.translator({ en: {hi:'Hi {n}'}, 'pt-BR': {hi:'Olá {n}'} });
     *   t('hi', { n: 'world' });
     * Lookup falls back: current locale to en to the key itself, with {var} interpolation.
     */
    i18n: {
      locale: (window.__pluginContext || {}).locale || 'en',
      translator: function (messages) {
        messages = messages || {};
        return function (key, vars) {
          var loc = (window.__pluginContext || {}).locale || 'en';
          var dict = messages[loc] || messages.en || {};
          var s = (key in dict) ? dict[key] : ((messages.en && messages.en[key]) || key);
          return vars ? String(s).replace(/\{(\w+)\}/g, function (m, k) { return (k in vars) ? String(vars[k]) : m; }) : s;
        };
      }
    },
    listPlugins: function () { return call('plugins.list'); },
    readFile: function (path) { return call('files.read', { path: path }); }
  };
})();`;

/** Build the <head> injection (context + theme + shim) prepended to a plugin's HTML. */
export function buildIframeInjection(
  context: { namespace: string; projectId?: number; locale?: string },
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
  context: { namespace: string; projectId?: number; locale?: string },
  themeTokens: Record<string, string>,
): string {
  const injection = buildIframeInjection(context, themeTokens);
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${injection}\n</head>`);
  return `${injection}\n${html}`;
}
