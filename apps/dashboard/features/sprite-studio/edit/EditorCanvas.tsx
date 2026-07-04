/**
 * The <canvas> host. Everything here is refs + native DOM listeners — the hot
 * path (pointer move at pointer rate) NEVER reads or sets React state. The
 * engine owns pixels/viewport; this component only:
 *   - sizes the backing store to container × devicePixelRatio (ResizeObserver),
 *   - attaches the engine on mount / detaches on unmount (NOT dispose — the
 *     registry owns the engine lifetime across route unmounts),
 *   - forwards pointer + wheel gestures to the engine,
 *   - handles space-drag / middle-drag pan and ctrl/pinch wheel zoom,
 *   - publishes the cursor readout (image coords + hovered color, throttled).
 */
import { useEffect, useRef } from 'react';
import type { EditorEngine } from '../engine/EditorEngine.js';
import { spriteEditorActions } from '../store/editor-store.js';
import { getTool } from '../tools/index.js';
import { clearCursorReadout, setCursorReadout } from './cursor-readout.js';

const READOUT_THROTTLE_MS = 60;

export function EditorCanvas({ engine }: { engine: EditorEngine }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    engine.attach(canvas);
    const rect = container.getBoundingClientRect();
    engine.resize(rect.width, rect.height);
    if (engine.viewport.zoom === 1 && engine.viewport.panX === 0 && engine.viewport.panY === 0) {
      engine.viewport.fit(rect.width, rect.height, engine.doc.width, engine.doc.height);
      engine.invalidate();
    }

    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr) engine.resize(cr.width, cr.height);
    });
    ro.observe(container);

    // ── gesture state (refs only) ──────────────────────────────────────────
    let panning = false;
    let spaceHeld = false;
    let lastX = 0;
    let lastY = 0;
    let lastReadout = 0;

    const toScreen = (e: PointerEvent | WheelEvent) => {
      const b = canvas.getBoundingClientRect();
      return { x: e.clientX - b.left, y: e.clientY - b.top };
    };

    const toEvent = (e: PointerEvent, s: { x: number; y: number }) => ({
      screenX: s.x, screenY: s.y, shift: e.shiftKey, alt: e.altKey, buttons: e.buttons,
    });

    const publishReadout = (s: { x: number; y: number }) => {
      const now = performance.now();
      if (now - lastReadout < READOUT_THROTTLE_MS) return;
      lastReadout = now;
      const p = engine.viewport.screenToImage(s.x, s.y);
      const ix = Math.floor(p.x);
      const iy = Math.floor(p.y);
      const img = engine.getActiveImageData();
      if (!img || ix < 0 || iy < 0 || ix >= img.width || iy >= img.height) {
        setCursorReadout({ x: null, y: null, hex: null });
        return;
      }
      const i = (iy * img.width + ix) * 4;
      const d = img.data;
      const hex = `#${[d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      setCursorReadout({ x: ix, y: iy, hex });
    };

    const onDown = (e: PointerEvent) => {
      const s = toScreen(e);
      if (e.button === 1 || spaceHeld) {
        panning = true; lastX = e.clientX; lastY = e.clientY;
        canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      canvas.setPointerCapture(e.pointerId);
      engine.handlePointerDown(getTool(spriteEditorActions().activeTool), toEvent(e, s));
    };

    const onMove = (e: PointerEvent) => {
      const s = toScreen(e);
      if (panning) {
        engine.viewport.panBy(e.clientX - lastX, e.clientY - lastY);
        lastX = e.clientX; lastY = e.clientY;
        engine.invalidate();
        return;
      }
      publishReadout(s);
      engine.setBrushGhost(engine.viewport.screenToImage(s.x, s.y));
      if (e.buttons & 1) engine.handlePointerMove(getTool(spriteEditorActions().activeTool), toEvent(e, s));
    };

    const onUp = (e: PointerEvent) => {
      if (panning) { panning = false; return; }
      if (e.button !== 0) return;
      engine.handlePointerUp(getTool(spriteEditorActions().activeTool), toEvent(e, toScreen(e)));
    };

    const onLeave = () => { engine.setBrushGhost(null); clearCursorReadout(); };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = toScreen(e);
      if (e.ctrlKey || e.metaKey) {
        engine.viewport.wheelZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, s.x, s.y);
        engine.emitSummary(); // throttled — keeps the zoom % readout live
      } else {
        engine.viewport.panBy(-e.deltaX, -e.deltaY);
      }
      engine.invalidate();
    };

    const onKeyDown = (e: KeyboardEvent) => { if (e.code === 'Space') spaceHeld = true; };
    const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space') spaceHeld = false; };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    return () => {
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      engine.detach(); // registry owns lifetime — never dispose here
      clearCursorReadout();
    };
  }, [engine]);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-[#1e1e1e]">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none" />
    </div>
  );
}
