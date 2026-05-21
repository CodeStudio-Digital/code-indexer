/**
 * Interactive terminal panel — xterm.js wired to `/ws/terminal/:sessionId`.
 *
 * Two targets:
 *   - `sandbox` — `podman exec -it` inside the session's primary container.
 *   - `host`    — local PowerShell / bash at the project's `root_path`.
 *                 Gated by `MCP_HOST_TERMINAL_ENABLED=1` on the server.
 *
 * Reconnect strategy: on `close` with code 1001/1006/1011 we surface a
 * "Disconnected — click to reconnect" banner; the operator decides when
 * to reopen the PTY. Auto-reconnect would just respawn an idle shell
 * silently every time the user navigated away, which is rarely what they
 * want and obscures spawn failures.
 *
 * Dependencies: `@xterm/xterm` + `@xterm/addon-fit`. Both are bundled
 * by Vite, no separate CSS import is needed beyond `xterm.css`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

type Target = 'sandbox' | 'host';

interface TerminalPanelProps {
  sessionId: number;
}

interface ConnectionState {
  status: 'idle' | 'connecting' | 'open' | 'closed' | 'error';
  detail?: string;
}

const ESC = '\x1b';

export function TerminalPanel({ sessionId }: TerminalPanelProps) {
  const { t } = useTranslation(['agents']);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [target, setTarget] = useState<Target>('sandbox');
  const [state, setState] = useState<ConnectionState>({ status: 'idle' });
  const [reconnectCount, setReconnectCount] = useState(0);

  const wsUrl = useMemo(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws/terminal/${sessionId}?target=${target}`;
  }, [sessionId, target]);

  // Mount xterm once.
  useEffect(() => {
    if (!containerRef.current) return;
    const term = new XTerm({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
      theme: {
        background: '#0b0d12',
        foreground: '#dadfea',
        cursor: '#dadfea',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    xtermRef.current = term;
    fitRef.current = fit;

    const onResizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch {
        /* xterm not measured yet */
      }
    });
    onResizeObserver.observe(containerRef.current);

    return () => {
      onResizeObserver.disconnect();
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Open / close the WebSocket whenever target changes or operator clicks reconnect.
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;

    setState({ status: 'connecting' });
    const cols = term.cols;
    const rows = term.rows;
    const fullUrl = `${wsUrl}&cols=${cols}&rows=${rows}`;
    const ws = new WebSocket(fullUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setState({ status: 'open' });
      term.focus();
    };
    ws.onmessage = (ev) => {
      let parsed: { type?: string; data?: string; code?: number; message?: string };
      try {
        parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      if (parsed.type === 'data' && typeof parsed.data === 'string') {
        term.write(parsed.data);
      } else if (parsed.type === 'exit') {
        term.writeln(
          `\r\n${ESC}[33m${t('agents:terminal.shellExited', { code: parsed.code ?? '?' })}${ESC}[0m`,
        );
      } else if (parsed.type === 'error' && typeof parsed.message === 'string') {
        term.writeln(
          `\r\n${ESC}[31m${t('agents:terminal.runtimeError', { message: parsed.message })}${ESC}[0m`,
        );
      }
    };
    ws.onerror = () => {
      setState({ status: 'error', detail: t('agents:terminal.transportError', { defaultValue: 'WebSocket transport error' }) });
    };
    ws.onclose = (ev) => {
      setState({
        status: 'closed',
        detail: ev.reason || t('agents:terminal.closedCode', { code: ev.code, defaultValue: 'closed (code {{code}})' }),
      });
    };

    const onDataDisposable = term.onData((data) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'data', data }));
    });
    const onResizeDisposable = term.onResize(({ cols: c, rows: r }) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'resize', cols: c, rows: r }));
    });

    return () => {
      onDataDisposable.dispose();
      onResizeDisposable.dispose();
      try { ws.close(1000, 'panel unmount'); } catch { /* best-effort */ }
      wsRef.current = null;
    };
  }, [wsUrl, reconnectCount, t]);

  const statusLabel = state.status === 'open'
    ? t('agents:terminal.status.connected', { target })
    : state.status === 'connecting'
      ? t('agents:terminal.status.connecting')
      : state.status === 'closed'
        ? t('agents:terminal.status.disconnected', { detail: state.detail ?? '' })
        : state.status === 'error'
          ? t('agents:terminal.status.error', { detail: state.detail ?? '' })
          : t('agents:terminal.status.idle');

  const statusClass = state.status === 'open'
    ? 'text-emerald-500'
    : state.status === 'connecting'
      ? 'text-amber-500'
      : 'text-muted-foreground';

  return (
    <div className="flex flex-col h-full bg-card">
      <div className="flex items-center gap-3 px-3 py-2 border-b text-xs">
        <select
          className="bg-background border rounded px-2 py-1"
          value={target}
          onChange={(e) => setTarget(e.target.value as Target)}
          title={t('agents:terminal.targetTitle')}
        >
          <option value="sandbox">{t('agents:terminal.target.sandbox')}</option>
          <option value="host">{t('agents:terminal.target.host')}</option>
        </select>
        <span className={statusClass}>{statusLabel}</span>
        {(state.status === 'closed' || state.status === 'error') && (
          <button
            className="ml-auto px-2 py-1 border rounded hover:bg-muted"
            onClick={() => setReconnectCount((n) => n + 1)}
          >
            {t('agents:terminal.reconnect')}
          </button>
        )}
      </div>
      <div ref={containerRef} className="flex-1 min-h-0 p-1" />
    </div>
  );
}
