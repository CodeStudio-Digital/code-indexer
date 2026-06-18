/**
 * Shared types for the pure 3-way merge model (no Monaco). A MergeModel is a
 * flat, ordered list of regions covering the whole file — `unchanged` runs
 * plus the changes each side made relative to the common ancestor (base).
 */

export type RegionKind =
  | 'unchanged' // base === ours === theirs over this range
  | 'oursOnly' // only ours changed (theirs === base)
  | 'theirsOnly' // only theirs changed (ours === base)
  | 'bothSame' // ours and theirs made the IDENTICAL change → auto-resolved
  | 'conflict'; // both changed the same base range differently

export type ResolutionChoice = 'base' | 'ours' | 'theirs' | 'both' | 'unresolved';

/**
 * A region's span in one source (base/ours/theirs/result). 1-based lines.
 * An EMPTY span (the side contributes no lines) has `endLine = startLine - 1`,
 * anchored before `startLine`.
 */
export interface RegionSide {
  startLine: number;
  endLine: number;
  /** The lines joined with '\n' (no trailing newline); '' when empty. */
  text: string;
}

export interface MergeRegion {
  id: string;
  kind: RegionKind;
  base: RegionSide;
  ours: RegionSide;
  theirs: RegionSide;
  /** The side pre-selected for the (marker-free) initial Result. */
  resolution: ResolutionChoice;
  /** True only for `conflict` — the user must act before Apply is clean. */
  unresolved: boolean;
}

export type MergeMode = 'three-way' | 'addAdd' | 'modifyDelete';

export interface MergeModel {
  regions: MergeRegion[];
  /** Regions where kind !== 'unchanged'. */
  changeCount: number;
  /** Regions where kind === 'conflict'. */
  conflictCount: number;
  mode: MergeMode;
}
