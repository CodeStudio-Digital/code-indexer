/**
 * Contract for the platform-specific process collectors, plus the frame
 * bookkeeping both share.
 *
 * A source keeps exactly two frames alive: the newest one and its predecessor.
 * Rates (CPU %, disk throughput) are deltas, so the previous frame is not
 * history — it is an operand. Anything older is genuinely useless here.
 */
import type { CensusFrame } from '@mcp/shared/utils/process-census/types.js';

export type CensusStatus =
  /** Not collecting — nobody has asked for a snapshot recently. */
  | 'stopped'
  /** Collector launched, first frame not in yet (PowerShell costs ~1.5s to boot). */
  | 'warming'
  /** At least one frame collected. */
  | 'live'
  /** The collector failed repeatedly; the panel degrades to Electron-only rows. */
  | 'failed';

export interface CensusSource {
  start: (intervalMs: number) => void;
  stop: () => void;
  /** Newest complete frame, or null while warming/failed. */
  latest: () => CensusFrame | null;
  /** The frame before `latest`, used as the delta operand. */
  previous: () => CensusFrame | null;
  status: () => CensusStatus;
}

/**
 * Frame ring + status shared by both collectors. Subclassing is deliberate
 * here: the two sources differ only in how they produce frames, not in how
 * frames are retained.
 */
export abstract class BaseCensusSource implements CensusSource {
  private frames: [CensusFrame | null, CensusFrame | null] = [null, null];
  private state: CensusStatus = 'stopped';

  abstract start(intervalMs: number): void;
  abstract stop(): void;

  latest(): CensusFrame | null {
    return this.frames[1];
  }

  previous(): CensusFrame | null {
    return this.frames[0];
  }

  status(): CensusStatus {
    return this.state;
  }

  protected acceptFrame(frame: CensusFrame): void {
    this.frames = [this.frames[1], frame];
    this.state = 'live';
  }

  protected setStatus(state: CensusStatus): void {
    this.state = state;
  }

  /** Drop retained frames so a restarted collector never derives a rate across
   *  the gap — the CPU counters are fine, but the wall-clock delta would span
   *  the outage and understate every percentage. */
  protected clearFrames(): void {
    this.frames = [null, null];
  }
}
