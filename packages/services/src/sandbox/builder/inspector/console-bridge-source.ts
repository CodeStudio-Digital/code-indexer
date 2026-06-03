/**
 * Source of the console/error/network bridge that runs inside the preview
 * app. Captures runtime problems the dashboard can't otherwise see across
 * the cross-origin iframe boundary and forwards them as `mcp:console` /
 * `mcp:runtime-error` / `mcp:network` messages.
 *
 * Always-on (independent of select mode) so errors surface immediately.
 * Deduped + throttled by signature so a render-loop error can't flood the
 * channel. Written as a string because it is compiled into the sandbox's
 * Vite app, not this package.
 */
export const CONSOLE_BRIDGE_SOURCE = String.raw`// MCP Builder console/error/network bridge.
function initMcpConsoleBridge(post) {
  var seen = Object.create(null);
  function fresh(sig) {
    var now = Date.now();
    var last = seen[sig] || 0;
    if (now - last < 2000) return false; // throttle identical signatures
    seen[sig] = now;
    return true;
  }
  function send(msg) {
    try { post(msg); } catch (e) { /* preview detached */ }
  }

  // console.error / console.warn
  ['error', 'warn'].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      try {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) {
          var a = arguments[i];
          parts.push(a && a.stack ? a.stack : (typeof a === 'string' ? a : safeStr(a)));
        }
        var message = parts.join(' ');
        if (message && fresh(level + '|' + message.slice(0, 200))) {
          send({ type: 'mcp:console', level: level, message: message.slice(0, 4000), ts: Date.now() });
        }
      } catch (e) { /* ignore */ }
      return orig.apply(console, arguments);
    };
  });

  // Uncaught errors
  window.addEventListener('error', function (ev) {
    try {
      var msg = ev && ev.message ? ev.message : 'Uncaught error';
      var stack = ev && ev.error && ev.error.stack ? String(ev.error.stack) : undefined;
      var source = ev && ev.filename ? (ev.filename + ':' + (ev.lineno || 0) + ':' + (ev.colno || 0)) : undefined;
      if (fresh('err|' + msg.slice(0, 200))) {
        send({ type: 'mcp:runtime-error', message: String(msg).slice(0, 4000), stack: stack, source: source, ts: Date.now() });
      }
    } catch (e) { /* ignore */ }
  });

  // Unhandled promise rejections
  window.addEventListener('unhandledrejection', function (ev) {
    try {
      var r = ev && ev.reason;
      var msg = r && r.message ? r.message : safeStr(r);
      var stack = r && r.stack ? String(r.stack) : undefined;
      if (fresh('rej|' + String(msg).slice(0, 200))) {
        send({ type: 'mcp:runtime-error', message: ('Unhandled rejection: ' + msg).slice(0, 4000), stack: stack, ts: Date.now() });
      }
    } catch (e) { /* ignore */ }
  });

  // Vite HMR compile errors (injected over the HMR channel)
  if (import.meta && import.meta.hot) {
    import.meta.hot.on('vite:error', function (payload) {
      try {
        var err = payload && payload.err ? payload.err : payload;
        var msg = err && err.message ? err.message : 'Vite compile error';
        send({ type: 'mcp:runtime-error', message: String(msg).slice(0, 4000), stack: err && err.stack ? String(err.stack) : undefined, ts: Date.now() });
      } catch (e) { /* ignore */ }
    });
  }

  // Network 4xx/5xx via fetch
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function () {
      var args = arguments;
      var method = (args[1] && args[1].method) || (args[0] && args[0].method) || 'GET';
      var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      return origFetch.apply(window, args).then(function (res) {
        try {
          if (res && res.status >= 400 && fresh('net|' + method + '|' + url + '|' + res.status)) {
            send({ type: 'mcp:network', url: String(url), method: String(method), status: res.status, statusText: String(res.statusText || ''), ts: Date.now() });
          }
        } catch (e) { /* ignore */ }
        return res;
      });
    };
  }

  // Network 4xx/5xx via XMLHttpRequest
  var XHR = window.XMLHttpRequest;
  if (XHR) {
    var origOpen = XHR.prototype.open;
    var origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__mcpMethod = method; this.__mcpUrl = url;
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      var self = this;
      this.addEventListener('loadend', function () {
        try {
          if (self.status >= 400 && fresh('net|' + self.__mcpMethod + '|' + self.__mcpUrl + '|' + self.status)) {
            send({ type: 'mcp:network', url: String(self.__mcpUrl || ''), method: String(self.__mcpMethod || 'GET'), status: self.status, statusText: String(self.statusText || ''), ts: Date.now() });
          }
        } catch (e) { /* ignore */ }
      });
      return origSend.apply(this, arguments);
    };
  }

  function safeStr(v) {
    try { return typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { return String(v); }
  }
}
`;
