/**
 * Linear undo/redo stack over three command kinds:
 *  - 'tiles': per-layer 64px tile diffs (the normal path — strokes, fills)
 *  - 'snapshot': whole-document before/after (layer ops, resize — rare)
 *  - 'selection': selection mask before/after
 *
 * HARD budget: 64MB of payload + 100 commands, oldest-first eviction.
 * Stroke coalescing: beginStroke → touchTiles (lazy pristine capture) →
 * endStroke collapses an entire pointer-down→up into ONE command.
 * The History never applies commands — the engine owns application.
 */
import type { DocSnapshot, PixelBuffer, TilePatch } from './engine-types.js';
import { applyTiles, captureTiles, diffTiles } from './tile-diff.js';

export interface TilesCommand {
  kind: 'tiles';
  layerId: string;
  label: string;
  before: TilePatch[];
  after: TilePatch[];
  bytes: number;
}

export interface SnapshotCommand {
  kind: 'snapshot';
  label: string;
  before: DocSnapshot;
  after: DocSnapshot;
  bytes: number;
}

export interface SelectionCommand {
  kind: 'selection';
  label: string;
  before: Uint8Array | null;
  after: Uint8Array | null;
  bytes: number;
}

export type Command = TilesCommand | SnapshotCommand | SelectionCommand;

export const HISTORY_BYTE_BUDGET = 64 * 1024 * 1024;
export const HISTORY_MAX_COMMANDS = 100;

export function snapshotBytes(s: DocSnapshot): number {
  let bytes = 0;
  for (const l of s.layers) bytes += l.data.byteLength;
  return bytes;
}

interface StrokeState {
  layerId: string;
  label: string;
  before: Map<string, TilePatch>;
}

export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private stroke: StrokeState | null = null;
  private readonly byteBudget: number;
  private readonly maxCommands: number;
  /** Fired on push/undo/redo/clear — the engine syncs its summary from it. */
  onChange: (() => void) | null = null;

  constructor(opts: { byteBudget?: number; maxCommands?: number } = {}) {
    this.byteBudget = opts.byteBudget ?? HISTORY_BYTE_BUDGET;
    this.maxCommands = opts.maxCommands ?? HISTORY_MAX_COMMANDS;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get length(): number {
    return this.undoStack.length;
  }

  get totalBytes(): number {
    let sum = 0;
    for (const c of this.undoStack) sum += c.bytes;
    for (const c of this.redoStack) sum += c.bytes;
    return sum;
  }

  push(cmd: Command): void {
    this.redoStack.length = 0;
    this.undoStack.push(cmd);
    this.evict();
    this.onChange?.();
  }

  pushSelection(before: Uint8Array | null, after: Uint8Array | null, label = 'Selection'): void {
    this.push({
      kind: 'selection',
      label,
      before,
      after,
      bytes: (before?.byteLength ?? 0) + (after?.byteLength ?? 0),
    });
  }

  pushSnapshot(before: DocSnapshot, after: DocSnapshot, label: string): void {
    this.push({ kind: 'snapshot', label, before, after, bytes: snapshotBytes(before) + snapshotBytes(after) });
  }

  /** Pop the command to undo — the CALLER applies its `before` state. */
  undo(): Command | null {
    const cmd = this.undoStack.pop() ?? null;
    if (cmd) {
      this.redoStack.push(cmd);
      this.onChange?.();
    }
    return cmd;
  }

  /** Pop the command to redo — the CALLER applies its `after` state. */
  redo(): Command | null {
    const cmd = this.redoStack.pop() ?? null;
    if (cmd) {
      this.undoStack.push(cmd);
      this.onChange?.();
    }
    return cmd;
  }

  // ── Stroke coalescing (one command per pointer-down→up) ────────────────

  beginStroke(layerId: string, label: string): void {
    this.stroke = { layerId, label, before: new Map() };
  }

  /** Capture the PRISTINE content of tiles about to be painted — call BEFORE
   *  mutating pixels. Tiles already captured this stroke are skipped. */
  touchTiles(img: PixelBuffer, keys: Iterable<string>): void {
    if (!this.stroke) return;
    const fresh: string[] = [];
    for (const k of keys) if (!this.stroke.before.has(k)) fresh.push(k);
    if (fresh.length === 0) return;
    for (const t of captureTiles(img, fresh).tiles) {
      this.stroke.before.set(`${t.tx}:${t.ty}`, t);
    }
  }

  /** Close the stroke: diff touched tiles and push one command (or none if
   *  nothing actually changed). Returns the pushed command. */
  endStroke(img: PixelBuffer): Command | null {
    const stroke = this.stroke;
    this.stroke = null;
    if (!stroke || stroke.before.size === 0) return null;
    const before = [...stroke.before.values()];
    const after = captureTiles(img, stroke.before.keys()).tiles;
    const diff = diffTiles(before, after);
    if (diff.after.length === 0) return null;
    const cmd: TilesCommand = {
      kind: 'tiles',
      layerId: stroke.layerId,
      label: stroke.label,
      before: diff.before,
      after: diff.after,
      bytes: diff.bytes,
    };
    this.push(cmd);
    return cmd;
  }

  /** Abort the stroke; when `img` is given, restores the captured tiles. */
  cancelStroke(img?: PixelBuffer): void {
    const stroke = this.stroke;
    this.stroke = null;
    if (stroke && img) applyTiles(img, [...stroke.before.values()]);
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.stroke = null;
    this.onChange?.();
  }

  /** Oldest-first eviction to honor the hard budget. The newest command is
   *  always kept even if it alone exceeds the byte budget. */
  private evict(): void {
    while (this.undoStack.length > this.maxCommands) this.undoStack.shift();
    while (this.undoStack.length > 1 && this.totalBytes > this.byteBudget) this.undoStack.shift();
  }
}
