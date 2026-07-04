/**
 * EditorEngine — the facade that owns document, viewport, history, selection,
 * compositor and overlays. Lives OUTSIDE React (see engine-registry): pointer
 * moves at 120Hz never touch React; the store only receives a throttled
 * summary. Render loop is rAF + dirty flag — zero draws without changes,
 * except while a selection exists (ants animation needs frames).
 */
import { applyHistoryCommand } from './apply-command.js';
import { Compositor } from './compositor.js';
import { EditorDocument } from './document.js';
import { imageDataFromSource, pngBlobFromImageData } from './engine-io.js';
import type { EngineSummary } from './engine-types.js';
import { History } from './history.js';
import {
  createBrushGhost, createCheckerboard, createMarchingAnts, createPixelGrid,
  OverlayRegistry, type OverlayView,
} from './overlays.js';
import { SelectionMask } from './selection-mask.js';
import { Viewport } from './viewport.js';
import type { Tool, ToolContext, ToolOptions, ToolPointerEvent } from '../tools/tool-types.js';

const SUMMARY_THROTTLE_MS = 100; // ~10Hz max toward the store

export class EditorEngine {
  readonly doc: EditorDocument;
  readonly viewport = new Viewport();
  readonly history = new History();
  readonly selection: SelectionMask;
  readonly overlays = new OverlayRegistry();
  private readonly compositor = new Compositor();

  private canvas: HTMLCanvasElement | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private rafId = 0;
  private needsRender = true;
  private dpr = 1;
  private readonly view: OverlayView;

  private toolOptions: ToolOptions = { size: 1, softness: 0, tolerance: 0, contiguous: true, shape: 'square' };
  private colors = { fg: '#000000', bg: '#ffffff' };
  private frameSource: (() => ImageData | null) | null = null;
  private onColorPick: ((hex: string) => void) | null = null;
  private onSummaryChange: ((s: EngineSummary) => void) | null = null;
  private summaryTimer: ReturnType<typeof setTimeout> | null = null;
  private fittedOnce = false;
  /**
   * Which asset version the document was loaded from (registry bookkeeping —
   * lets the view reload when the active version changes and the doc has no
   * unsaved edits, instead of trusting "layers exist" forever).
   */
  loadedVersionId: number | null = null;

  constructor(width: number, height: number) {
    this.doc = new EditorDocument(width, height);
    this.selection = new SelectionMask(width, height);
    this.view = {
      viewport: this.viewport, docW: width, docH: height, dpr: 1,
      canvasW: 0, canvasH: 0, selection: this.selection, timeMs: 0, brush: null,
    };
    for (const o of [createCheckerboard(), createPixelGrid(), createMarchingAnts(), createBrushGhost()]) {
      this.overlays.register(o);
    }
    this.history.onChange = () => this.emitSummary();
    this.selection.onChange = () => {
      this.invalidate();
      this.emitSummary();
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  attach(canvas: HTMLCanvasElement): void {
    this.detach();
    this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d');
    this.dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.invalidate();
    const tick = (t: number) => {
      this.rafId = requestAnimationFrame(tick);
      const animating = !this.selection.isEmpty(); // ants dash offset
      if (this.needsRender || animating) this.renderFrame(t);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  detach(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.canvas = null;
    this.ctx2d = null;
  }

  /** Size the backing store for a CSS size (call on container resize). */
  resize(cssW: number, cssH: number): void {
    if (!this.canvas) return;
    this.canvas.width = Math.max(1, Math.round(cssW * this.dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * this.dpr));
    // First layout after attach: frame the document instead of dumping it at
    // 1x in the top-left corner.
    if (!this.fittedOnce && this.doc.layers.length > 0) {
      this.fitToView();
      this.fittedOnce = true;
    }
    this.invalidate();
  }

  /** Fit the whole document in the attached canvas (no-op when detached). */
  fitToView(): void {
    if (!this.canvas) return;
    const cssW = this.canvas.width / this.dpr;
    const cssH = this.canvas.height / this.dpr;
    this.viewport.fit(cssW, cssH, this.doc.width, this.doc.height);
    this.invalidate();
    this.emitSummary();
  }

  /** 100% zoom centered (companion of fitToView for the status bar). */
  zoomTo100(): void {
    if (!this.canvas) return;
    const cssW = this.canvas.width / this.dpr;
    const cssH = this.canvas.height / this.dpr;
    this.viewport.zoomTo100(cssW, cssH, this.doc.width, this.doc.height);
    this.invalidate();
    this.emitSummary();
  }

  /** Absolute zoom anchored at the visual center of the attached canvas —
   *  the status-bar zoom slider/input companion of fitToView/zoomTo100.
   *  Clamping happens inside viewport.setZoom (no-op when detached). */
  setZoomCentered(zoom: number): void {
    if (!this.canvas) return;
    const cssW = this.canvas.width / this.dpr;
    const cssH = this.canvas.height / this.dpr;
    this.viewport.setZoom(zoom, cssW / 2, cssH / 2);
    this.invalidate();
    this.emitSummary();
  }

  dispose(): void {
    this.detach();
    this.compositor.dispose();
    this.history.clear();
    if (this.summaryTimer) clearTimeout(this.summaryTimer);
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  invalidate(): void {
    this.needsRender = true;
  }

  private renderFrame(timeMs: number): void {
    const ctx = this.ctx2d;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;
    this.needsRender = false;
    this.compositor.pruneLayers(this.doc);
    this.compositor.syncDirty(this.doc);
    // Mutate the shared view object — no allocation in the hot path. Doc dims
    // follow the document (resize/crop ops change them mid-session).
    this.view.dpr = this.dpr;
    this.view.canvasW = canvas.width / this.dpr;
    this.view.canvasH = canvas.height / this.dpr;
    this.view.docW = this.doc.width;
    this.view.docH = this.doc.height;
    this.view.timeMs = timeMs;
    this.compositor.render(ctx, this.doc, this.overlays, this.view);
  }

  /** Brush ghost hover position (image coords) — null hides it. */
  setBrushGhost(pos: { x: number; y: number } | null): void {
    this.view.brush = pos
      ? { x: pos.x, y: pos.y, size: this.toolOptions.size, shape: this.toolOptions.shape ?? 'square' }
      : null;
    this.invalidate();
  }

  // ── Pointer entry points (screen coords + active tool) ──────────────────

  handlePointerDown(tool: Tool, e: Omit<ToolPointerEvent, 'imageX' | 'imageY'>): void {
    tool.onDown(this.toPointerEvent(e), this.toolContext());
  }

  handlePointerMove(tool: Tool, e: Omit<ToolPointerEvent, 'imageX' | 'imageY'>): void {
    tool.onMove(this.toPointerEvent(e), this.toolContext());
  }

  handlePointerUp(tool: Tool, e: Omit<ToolPointerEvent, 'imageX' | 'imageY'>): void {
    tool.onUp(this.toPointerEvent(e), this.toolContext());
    this.emitSummary();
  }

  private toPointerEvent(e: Omit<ToolPointerEvent, 'imageX' | 'imageY'>): ToolPointerEvent {
    const p = this.viewport.screenToImage(e.screenX, e.screenY);
    return { ...e, imageX: p.x, imageY: p.y };
  }

  private toolContext(): ToolContext {
    return {
      doc: this.doc,
      selection: this.selection,
      history: this.history,
      viewport: this.viewport,
      options: this.toolOptions,
      colors: this.colors,
      invalidate: () => this.invalidate(),
      pickColor: (hex) => {
        this.colors.fg = hex;
        this.onColorPick?.(hex);
      },
    };
  }

  setToolOptions(patch: Partial<ToolOptions>): void {
    Object.assign(this.toolOptions, patch);
  }

  setColors(colors: { fg?: string; bg?: string }): void {
    if (colors.fg) this.colors.fg = colors.fg;
    if (colors.bg) this.colors.bg = colors.bg;
  }

  setColorPickListener(cb: ((hex: string) => void) | null): void {
    this.onColorPick = cb;
  }

  // ── Frame source indirection (phase-2 playback swaps this) ──────────────

  setFrameSource(source: (() => ImageData | null) | null): void {
    this.frameSource = source;
  }

  /** The single pixel accessor tools/algorithms should read through. */
  getActiveImageData(): ImageData | null {
    if (this.frameSource) return this.frameSource();
    return this.doc.activeLayer?.imageData ?? null;
  }

  // ── Undo / redo (History pops, engine applies) ───────────────────────────

  undo(): void {
    this.applyCommand(this.history.undo(), 'before');
  }

  redo(): void {
    this.applyCommand(this.history.redo(), 'after');
  }

  private applyCommand(cmd: ReturnType<History['undo']>, side: 'before' | 'after'): void {
    if (!cmd) return;
    applyHistoryCommand(cmd, side, this.doc, this.selection);
    // Undo/redo across a resize boundary changes the doc dimensions — the
    // selection coordinate space must follow (drops the stale mask).
    this.selection.resize(this.doc.width, this.doc.height);
    this.invalidate();
    this.emitSummary();
  }

  // ── I/O ──────────────────────────────────────────────────────────────────

  /** Reset to a single-layer document from an image (dimension-aware). */
  loadFromImage(src: ImageData | HTMLImageElement, versionId: number | null = null): void {
    const img = imageDataFromSource(src);
    this.doc.resizeTo(img.width, img.height);
    this.selection.resize(img.width, img.height);
    this.doc.layers = [];
    this.doc.addLayer('Background', img);
    this.history.clear();
    this.selection.clear();
    this.loadedVersionId = versionId;
    this.fitToView();
    this.invalidate();
  }

  /**
   * Commit a dimension-changing result (upscale, crop) as an UNDOABLE
   * whole-document snapshot. Snapshots carry dims, `restore()` reapplies
   * them and the compositor self-heals — so undo across a resize is safe.
   * Multi-layer documents refuse (resizing one layer of many is incoherent);
   * the caller surfaces "flatten first".
   */
  applyResizedActive(img: ImageData, label: string): boolean {
    const layer = this.doc.activeLayer;
    if (!layer || this.doc.layers.length !== 1) return false;
    const before = this.doc.snapshot();
    this.doc.resizeTo(img.width, img.height);
    this.selection.resize(img.width, img.height);
    layer.imageData = img;
    this.doc.markAllDirty(layer.id);
    const after = this.doc.snapshot();
    this.history.pushSnapshot(before, after, label);
    this.fitToView();
    this.invalidate();
    this.emitSummary();
    return true;
  }

  /** Flatten and encode as PNG. */
  exportPngBlob(): Promise<Blob> {
    return pngBlobFromImageData(this.doc.flatten());
  }

  // ── Summary for the store (throttled ≤10Hz) ─────────────────────────────

  get summary(): EngineSummary {
    return {
      zoomPct: Math.round(this.viewport.zoom * 100),
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      hasSelection: !this.selection.isEmpty(),
      memBytes: this.history.totalBytes,
      docW: this.doc.width,
      docH: this.doc.height,
      layerCount: this.doc.layers.length,
    };
  }

  setSummaryListener(cb: ((s: EngineSummary) => void) | null): void {
    this.onSummaryChange = cb;
    if (cb) cb(this.summary);
  }

  emitSummary(): void {
    if (!this.onSummaryChange || this.summaryTimer) return;
    this.summaryTimer = setTimeout(() => {
      this.summaryTimer = null;
      this.onSummaryChange?.(this.summary);
    }, SUMMARY_THROTTLE_MS);
  }
}
