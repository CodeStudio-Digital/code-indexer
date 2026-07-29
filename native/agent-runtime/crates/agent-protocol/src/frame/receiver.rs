use std::sync::atomic::{AtomicU64, Ordering};

use super::bootstrap::NegotiatedReceiverSeed;
use super::direction::validate_payload_direction;
use super::{ValidatedOpaqueEnvelope, decode_attempt_payload, validate_opaque_envelope};

mod error;
mod history;
mod model;
mod receipt;
mod replay;
mod transaction;

pub use error::InboundFrameError;
use history::{HistoryMatch, MessageHistory};
pub use model::{BoundedReplayOutcome, FrameReceiveOutcome, PendingInbound, ReplayedFrame};
pub use receipt::{CommittedInbound, InboundBinding};
use replay::ReplayReservation;

pub const MAX_REPLAY_WINDOW_ENTRIES: usize = 4_096;
pub const MAX_TRACKED_MESSAGE_IDS: usize = 65_536;

static NEXT_RECEIVER_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
struct PendingReservation {
    token: u64,
    message_id: String,
    stream_seq: u64,
    envelope_digest: [u8; 32],
}

#[derive(Debug)]
pub struct AttemptFrameReceiver {
    receiver_id: u64,
    seed: NegotiatedReceiverSeed,
    last_stream_seq: u64,
    next_pending_token: u64,
    pending: Option<PendingReservation>,
    replay: Option<ReplayReservation>,
    history: MessageHistory,
    poisoned: bool,
}

impl AttemptFrameReceiver {
    /// Creates an established receiver only from a validated bootstrap seed.
    ///
    /// # Errors
    ///
    /// Rejects invalid active replay or total identity capacities.
    pub fn from_seed(
        seed: NegotiatedReceiverSeed,
        replay_capacity: usize,
        total_identity_capacity: usize,
        max_replay_bytes: usize,
    ) -> Result<Self, InboundFrameError> {
        if replay_capacity == 0 {
            return Err(InboundFrameError::InvalidReplayWindow);
        }
        if replay_capacity > MAX_REPLAY_WINDOW_ENTRIES {
            return Err(InboundFrameError::ReplayWindowTooLarge {
                requested: replay_capacity,
                maximum: MAX_REPLAY_WINDOW_ENTRIES,
            });
        }
        if total_identity_capacity == 0
            || total_identity_capacity > MAX_TRACKED_MESSAGE_IDS
            || replay_capacity > total_identity_capacity
        {
            return Err(InboundFrameError::InvalidTotalIdentityCapacity);
        }
        if max_replay_bytes == 0 {
            return Err(InboundFrameError::InvalidReplayByteBudget);
        }
        let receiver_id = NEXT_RECEIVER_ID
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                current.checked_add(1)
            })
            .map_err(|_| InboundFrameError::ReceiverIdExhausted)?;
        let mut history =
            MessageHistory::new(replay_capacity, total_identity_capacity, max_replay_bytes);
        if !history.reserve_tombstone(seed.bootstrap_message_id.clone()) {
            return Err(InboundFrameError::IdentityCapacityExhausted);
        }
        Ok(Self {
            receiver_id,
            last_stream_seq: seed.stream_watermark,
            seed,
            next_pending_token: 0,
            pending: None,
            replay: None,
            history,
            poisoned: false,
        })
    }

    /// Validates one envelope and reserves it without advancing durable state.
    ///
    /// # Errors
    ///
    /// Structural or semantic failures poison the receiver. While one message
    /// is pending, no additional envelope is consumed or validated.
    pub fn begin_receive<F>(
        &mut self,
        encoded_frame: &[u8],
        clock: F,
    ) -> Result<FrameReceiveOutcome, InboundFrameError>
    where
        F: FnOnce() -> i64,
    {
        if self.poisoned {
            return Err(InboundFrameError::ReceiverPoisoned);
        }
        if self.pending.is_some() {
            return Err(InboundFrameError::PendingInboundActive);
        }
        self.replay = None;
        let observed_at_unix_ms = clock();
        let result = self.begin_unpoisoned(encoded_frame, observed_at_unix_ms);
        if result.is_err() {
            self.poison();
        }
        result
    }

    fn begin_unpoisoned(
        &mut self,
        encoded_frame: &[u8],
        observed_at_unix_ms: i64,
    ) -> Result<FrameReceiveOutcome, InboundFrameError> {
        if observed_at_unix_ms <= 0 {
            return Err(InboundFrameError::InvalidObservedAt(observed_at_unix_ms));
        }
        let opaque = validate_opaque_envelope(
            encoded_frame,
            self.seed.channel,
            self.seed.maximum_frame_bytes,
        )?;
        self.validate_context(&opaque)?;
        match self
            .history
            .classify(opaque.message_id.as_str(), &opaque.envelope_digest)
        {
            HistoryMatch::Replay { frame, response } => {
                self.replay = Some(ReplayReservation::new(&frame, response));
                return Ok(FrameReceiveOutcome::Replay(frame));
            }
            HistoryMatch::Conflict => return Err(InboundFrameError::MessageIdConflict),
            HistoryMatch::Tombstone => return Err(InboundFrameError::MessageIdRetired),
            HistoryMatch::Unknown => {}
        }
        if let Some(deadline_at) = opaque.header.deadline_at_unix_ms
            && observed_at_unix_ms >= deadline_at
        {
            return Err(InboundFrameError::DeadlineExpired {
                deadline_at,
                observed_at: observed_at_unix_ms,
            });
        }
        if !self.history.can_track_new() {
            return Err(InboundFrameError::IdentityCapacityExhausted);
        }
        let expected = self
            .last_stream_seq
            .checked_add(1)
            .ok_or(InboundFrameError::SequenceExhausted)?;
        if opaque.header.stream_seq != expected {
            return Err(InboundFrameError::SequenceMismatch {
                expected,
                actual: opaque.header.stream_seq,
            });
        }
        let validated = decode_attempt_payload(opaque)?;
        validate_payload_direction(self.seed.direction, validated.channel, &validated.body)
            .map_err(InboundFrameError::Direction)?;
        self.reserve_pending(validated)
    }

    fn reserve_pending(
        &mut self,
        validated: super::ValidatedAttemptFrame,
    ) -> Result<FrameReceiveOutcome, InboundFrameError> {
        let token = self
            .next_pending_token
            .checked_add(1)
            .ok_or(InboundFrameError::PendingTokenExhausted)?;
        self.next_pending_token = token;
        let message_id = validated.message_id.as_str().to_owned();
        let stream_seq = validated.header.stream_seq;
        let envelope_digest = validated.envelope_digest;
        self.pending = Some(PendingReservation {
            token,
            message_id: message_id.clone(),
            stream_seq,
            envelope_digest,
        });
        Ok(FrameReceiveOutcome::Pending(Box::new(PendingInbound::new(
            self.receiver_id,
            token,
            message_id,
            stream_seq,
            envelope_digest,
            validated,
        ))))
    }

    fn validate_context(&self, opaque: &ValidatedOpaqueEnvelope) -> Result<(), InboundFrameError> {
        if opaque.channel != self.seed.channel {
            return Err(InboundFrameError::UnsupportedChannel(opaque.channel));
        }
        if opaque.protocol_version != self.seed.protocol {
            return Err(InboundFrameError::ProtocolMismatch);
        }
        if opaque.connection_id != self.seed.connection {
            return Err(InboundFrameError::ConnectionMismatch);
        }
        if opaque.identity != self.seed.identity {
            return Err(InboundFrameError::AttemptIdentityMismatch);
        }
        Ok(())
    }
}
