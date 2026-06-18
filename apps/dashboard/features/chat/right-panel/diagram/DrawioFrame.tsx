/**
 * DrawioFrame — the embedded, self-hosted draw.io editor. ONE component, two
 * mounts: the wide chat panel (DiagramPanel) and the project editor tab
 * (DrawioEditor). It owns the postMessage handshake with the editor and is
 * otherwise controlled: the parent passes `xml` in and gets edits back via
 * `onChange`/`onSave`, plus an imperative `exportDiagram` for SVG/PNG.
 *
 * Anti-loop: `lastXmlRef` tracks the content the editor currently holds, so a
 * parent echoing an autosaved value back through `xml` does NOT re-trigger a
 * load. Autosave is debounced before it reaches `onChange`.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import {
  drawioEmbedUrl,
  parseDrawioEvent,
  toDrawioExportAction,
  type DrawioExportFormat,
} from './drawio-embed.js';

export interface DrawioFrameHandle {
  exportDiagram(format: DrawioExportFormat): void;
}

export interface DrawioFrameProps {
  /** The mxGraph XML to load. Null/empty opens a blank editor. */
  xml: string | null;
  title?: string;
  dark?: boolean;
  /** Fired (debounced) on every editor edit — the diagram XML changed. */
  onChange?: (xml: string) => void;
  /** Fired when the user explicitly saves (Ctrl+S) inside the editor. */
  onSave?: (xml: string) => void;
  /** Fired with a data URI when an export completes. */
  onExport?: (dataUrl: string, format: DrawioExportFormat) => void;
  className?: string;
}

const AUTOSAVE_DEBOUNCE_MS = 800;

export const DrawioFrame = forwardRef<DrawioFrameHandle, DrawioFrameProps>(function DrawioFrame(
  { xml, title, dark = true, onChange, onSave, onExport, className },
  ref,
) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const lastXmlRef = useRef<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingExportRef = useRef<DrawioExportFormat | null>(null);
  const srcRef = useRef(drawioEmbedUrl({ dark }));

  const post = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(JSON.stringify(msg), '*');
  }, []);

  const load = useCallback(
    (value: string) => {
      lastXmlRef.current = value;
      post({ action: 'load', xml: value ?? '', autosave: 1, modified: 0, title: title ?? '' });
    },
    [post, title],
  );

  useImperativeHandle(
    ref,
    () => ({
      exportDiagram(format) {
        pendingExportRef.current = format;
        post({ action: 'export', format: toDrawioExportAction(format) });
      },
    }),
    [post],
  );

  // Message bridge: only trust messages from OUR iframe (scheme-agnostic — the
  // editor loads from mcp://app whose event.origin is unreliable).
  useEffect(() => {
    function onMessage(e: MessageEvent): void {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const ev = parseDrawioEvent(e.data);
      if (!ev) return;
      switch (ev.event) {
        case 'init':
          readyRef.current = true;
          load(lastXmlRef.current ?? '');
          break;
        case 'autosave':
          if (typeof ev.xml === 'string') {
            const value = ev.xml;
            lastXmlRef.current = value;
            if (debounceRef.current) clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(() => onChange?.(value), AUTOSAVE_DEBOUNCE_MS);
          }
          break;
        case 'save':
          if (typeof ev.xml === 'string') {
            lastXmlRef.current = ev.xml;
            onSave?.(ev.xml);
          }
          break;
        case 'export':
          if (typeof ev.data === 'string' && pendingExportRef.current) {
            onExport?.(ev.data, pendingExportRef.current);
            pendingExportRef.current = null;
          }
          break;
        default:
          break;
      }
    }
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [load, onChange, onSave, onExport]);

  // External XML changes (agent edit, or a different diagram opened) → reload,
  // deduped against what the editor already holds. Before init, just stage it.
  useEffect(() => {
    if (!readyRef.current) {
      lastXmlRef.current = xml;
      return;
    }
    if (xml != null && xml !== lastXmlRef.current) load(xml);
  }, [xml, load]);

  return (
    <iframe
      ref={iframeRef}
      src={srcRef.current}
      title="draw.io"
      className={className ?? 'h-full w-full border-0 bg-white'}
    />
  );
});
