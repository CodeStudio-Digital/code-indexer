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
import { spriteEditorActions, useSpriteEditorStore } from '../store/editor-store.js';
import { getTool, GHOST_TOOLS, PAINT_TOOLS } from '../tools/index.js';
import type { Tool } from '../tools/tool-types.js';
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
    let altHeld = false;
    let lastX = 0;
    let lastY = 0;
    let lastReadout = 0;
    // The tool a gesture was CAPTURED with. onMove/onUp dispatch to it (never
    // re-read the store mid-drag — switching tools by keyboard used to orphan
    // the open stroke). Alt at pointer-down on a paint tool = PS temporary
    // eyedropper for that gesture.
    let gestureTool: Tool | null = null;

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
      const active = spriteEditorActions().activeTool;
      // Alt on a paint tool = temporary eyedropper for THIS gesture (PS habit).
      // Never on select tools — alt means subtract there.
      gestureTool = e.altKey && PAINT_TOOLS.has(active) ? getTool('eyedropper') : getTool(active);
      engine.handlePointerDown(gestureTool, toEvent(e, s));
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
      // Size ghost only for size-based tools — others get a bare crosshair.
      engine.setBrushGhost(
        GHOST_TOOLS.has(spriteEditorActions().activeTool)
          ? engine.viewport.screenToImage(s.x, s.y)
          : null,
      );
      if ((e.buttons & 1) && gestureTool) engine.handlePointerMove(gestureTool, toEvent(e, s));
    };

    const onUp = (e: PointerEvent) => {
      if (panning) { panning = false; return; }
      if (e.button !== 0) return;
      const tool = gestureTool ?? getTool(spriteEditorActions().activeTool);
      gestureTool = null;
      engine.handlePointerUp(tool, toEvent(e, toScreen(e)));
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

    const applyAltCursor = () => {
      canvas.style.cursor =
        altHeld && PAINT_TOOLS.has(spriteEditorActions().activeTool) ? 'copy' : '';
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeld = true;
      if (e.key === 'Alt') { altHeld = true; applyAltCursor(); e.preventDefault(); }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeld = false;
      if (e.key === 'Alt') { altHeld = false; applyAltCursor(); }
    };

    // Tool switched by KEYBOARD with the cursor parked inside the canvas:
    // the stale size-ghost must clear without waiting for a pointermove.
    const unsubGhost = useSpriteEditorStore.subscribe((s, prevState) => {
      if (s.activeTool !== prevState.activeTool && !GHOST_TOOLS.has(s.activeTool)) {
        engine.setBrushGhost(null);
      }
    });

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    return () => {
      ro.disconnect();
      unsubGhost();
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
