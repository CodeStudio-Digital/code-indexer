import {
  HostSupervisorFactError,
} from '../driver/HostSupervisorFactError.js';
import type {
  ReplayClassification,
} from './HostSupervisorReplayHistory.js';

const MAX_UINT64 = (1n << 64n) - 1n;

export type SupervisorSequenceDisposition =
  | { readonly kind: 'fresh' }
  | Extract<ReplayClassification, { kind: 'replay' }>;

export function validateSupervisorSequence(
  streamSeq: bigint,
  committedStreamSeq: bigint,
  replay: ReplayClassification,
  canTrackFresh: boolean,
): SupervisorSequenceDisposition {
  if (streamSeq === committedStreamSeq && replay.kind === 'replay') {
    return replay;
  }
  if (
    replay.kind === 'conflict'
    || (replay.kind === 'replay' && streamSeq !== committedStreamSeq)
  ) {
    throw new HostSupervisorFactError(
      'message_id_conflict',
      'management message ID was reused with different bytes',
    );
  }
  if (replay.kind === 'retired' || streamSeq <= committedStreamSeq) {
    throw new HostSupervisorFactError(
      'message_id_retired',
      'management message ID is outside the replay window',
    );
  }
  if (!canTrackFresh) {
    throw new HostSupervisorFactError(
      'identity_capacity_exhausted',
      'management identity capacity is exhausted',
    );
  }
  const expected = committedStreamSeq + 1n;
  if (committedStreamSeq === MAX_UINT64 || streamSeq !== expected) {
    throw new HostSupervisorFactError(
      'sequence_mismatch',
      `management stream sequence ${streamSeq} does not equal ${expected}`,
    );
  }
  return { kind: 'fresh' };
}
