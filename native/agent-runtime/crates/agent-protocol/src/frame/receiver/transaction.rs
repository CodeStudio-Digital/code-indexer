use super::history::{CommittedMessage, HistoryCommitError};
use super::{
    AttemptFrameReceiver, BoundedReplayOutcome, CommittedInbound, InboundFrameError, PendingInbound,
};
use crate::frame::sender::{OutboundFrameError, OutboundHeaderAuthority};

impl AttemptFrameReceiver {
    /// Produces a replay response value bounded by the negotiated frame cap.
    ///
    /// # Errors
    ///
    /// Rejects empty or oversized response bytes.
    pub fn bounded_response(
        &self,
        bytes: Vec<u8>,
    ) -> Result<BoundedReplayOutcome, InboundFrameError> {
        if bytes.is_empty() || bytes.len() > self.seed.maximum_frame_bytes {
            return Err(InboundFrameError::InvalidReplayResponse {
                length: bytes.len(),
                maximum: self.seed.maximum_frame_bytes,
            });
        }
        Ok(BoundedReplayOutcome::response(bytes))
    }

    /// Commits a handler outcome and only then advances sequence/history.
    ///
    /// # Errors
    ///
    /// Invalid tokens, response bounds, or exhausted history poison the receiver.
    pub fn commit(
        &mut self,
        pending: PendingInbound,
        outcome: BoundedReplayOutcome,
    ) -> Result<CommittedInbound, InboundFrameError> {
        if self.poisoned {
            return Err(InboundFrameError::ReceiverPoisoned);
        }
        let result = self.commit_unpoisoned(pending, outcome);
        if result.is_err() {
            self.poison();
        }
        result
    }

    fn commit_unpoisoned(
        &mut self,
        pending: PendingInbound,
        outcome: BoundedReplayOutcome,
    ) -> Result<CommittedInbound, InboundFrameError> {
        self.validate_pending(&pending)?;
        if let Some(response) = outcome.response_bytes()
            && (response.is_empty() || response.len() > self.seed.maximum_frame_bytes)
        {
            return Err(InboundFrameError::InvalidReplayResponse {
                length: response.len(),
                maximum: self.seed.maximum_frame_bytes,
            });
        }
        drop(pending);
        let reservation = self
            .pending
            .take()
            .ok_or(InboundFrameError::InvalidPending)?;
        let receipt = CommittedInbound::new(
            self.receiver_id,
            reservation.token,
            reservation.message_id.clone(),
            reservation.stream_seq,
            reservation.envelope_digest,
        );
        self.history
            .commit(
                reservation.message_id,
                CommittedMessage {
                    envelope_digest: reservation.envelope_digest,
                    stream_seq: reservation.stream_seq,
                    outcome,
                },
            )
            .map_err(|error| match error {
                HistoryCommitError::IdentityCapacityExhausted => {
                    InboundFrameError::IdentityCapacityExhausted
                }
                HistoryCommitError::ReplayByteBudgetExhausted { required, maximum } => {
                    InboundFrameError::ReplayByteBudgetExhausted { required, maximum }
                }
            })?;
        self.last_stream_seq = reservation.stream_seq;
        Ok(receipt)
    }

    /// Rejects handler work and permanently poisons the receiver.
    ///
    /// # Errors
    ///
    /// Returns an error for a foreign or stale pending token.
    pub fn reject(&mut self, pending: PendingInbound) -> Result<(), InboundFrameError> {
        let result = self.validate_pending(&pending);
        drop(pending);
        self.poison();
        result
    }

    fn validate_pending(&self, pending: &PendingInbound) -> Result<(), InboundFrameError> {
        let reservation = self
            .pending
            .as_ref()
            .ok_or(InboundFrameError::InvalidPending)?;
        if pending.receiver_id != self.receiver_id
            || pending.token != reservation.token
            || pending.message_id != reservation.message_id
            || pending.stream_seq != reservation.stream_seq
            || pending.envelope_digest != reservation.envelope_digest
        {
            return Err(InboundFrameError::InvalidPending);
        }
        Ok(())
    }

    pub(crate) fn poison(&mut self) {
        self.poisoned = true;
        self.pending = None;
        self.replay = None;
        self.history.clear();
    }

    #[must_use]
    pub const fn has_pending(&self) -> bool {
        self.pending.is_some()
    }

    #[must_use]
    pub const fn maximum_frame_bytes(&self) -> usize {
        self.seed.maximum_frame_bytes
    }

    #[must_use]
    pub fn replay_entry_count(&self) -> usize {
        self.history.active_count()
    }

    #[must_use]
    pub fn tombstone_count(&self) -> usize {
        self.history.tombstone_count()
    }

    #[must_use]
    pub const fn replay_bytes(&self) -> usize {
        self.history.replay_bytes()
    }

    #[must_use]
    pub const fn stream_watermark(&self) -> u64 {
        self.last_stream_seq
    }

    #[must_use]
    pub const fn is_poisoned(&self) -> bool {
        self.poisoned
    }

    pub(in crate::frame) fn outbound_authority(
        &self,
        committed_stream_seq: u64,
    ) -> Result<OutboundHeaderAuthority, OutboundFrameError> {
        OutboundHeaderAuthority::new(
            self.seed.protocol,
            self.seed.connection.clone(),
            self.seed.identity.clone(),
            self.seed.channel,
            self.seed.direction.reverse(),
            self.seed.maximum_frame_bytes,
            committed_stream_seq,
        )
    }
}
