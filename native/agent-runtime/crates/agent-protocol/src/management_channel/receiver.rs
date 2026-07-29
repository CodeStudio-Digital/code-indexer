use std::sync::atomic::{AtomicU64, Ordering};

use crate::management_frame::{management_envelope_sha256, validate_management_frame};

use super::direction::{forbidden_payload, payload_allowed};
use super::header::validate_management_header;
use super::{
    ManagementChannelError, ManagementReceiverContext, ManagementReplayLimits,
    ValidatedManagementEnvelope,
};

mod history;
mod model;
mod transaction;

use history::{HistoryMatch, ManagementHistory};
pub(in crate::management_channel) use model::ManagementReceiverOutcome;
use model::PendingReservation;
pub use model::{
    CommittedManagementInbound, ManagementInboundBinding, ManagementReceiveOutcome,
    PendingManagementInbound, ReplayedManagementFrame, ValidatedManagementPayload,
};

static NEXT_RECEIVER_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
pub(super) struct ManagementReceiver {
    receiver_id: u64,
    context: ManagementReceiverContext,
    last_stream_seq: u64,
    next_pending_token: u64,
    pending: Option<PendingReservation>,
    history: ManagementHistory,
    poisoned: bool,
}

impl ManagementReceiver {
    pub(super) fn from_context(
        context: ManagementReceiverContext,
        limits: ManagementReplayLimits,
    ) -> Result<Self, ManagementChannelError> {
        ManagementReplayLimits::new(limits.entries, limits.tracked_message_ids, limits.bytes)?;
        let receiver_id = NEXT_RECEIVER_ID
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_add(1)
            })
            .map_err(|_| ManagementChannelError::ReceiverIdExhausted)?;
        let mut history = ManagementHistory::new(limits);
        if !history.reserve_tombstone(context.bootstrap_message_id.clone()) {
            return Err(ManagementChannelError::IdentityCapacityExhausted);
        }
        Ok(Self {
            receiver_id,
            context,
            last_stream_seq: 1,
            next_pending_token: 0,
            pending: None,
            history,
            poisoned: false,
        })
    }

    pub(super) fn begin_receive(
        &mut self,
        encoded_frame: &[u8],
        observed_at: i64,
    ) -> Result<ManagementReceiverOutcome, ManagementChannelError> {
        if self.poisoned {
            return Err(ManagementChannelError::ChannelPoisoned);
        }
        if self.pending.is_some() {
            return Err(ManagementChannelError::PendingInboundActive);
        }
        let result = self.begin_unpoisoned(encoded_frame, observed_at);
        if result.is_err() {
            self.poison();
        }
        result
    }

    fn begin_unpoisoned(
        &mut self,
        encoded_frame: &[u8],
        observed_at: i64,
    ) -> Result<ManagementReceiverOutcome, ManagementChannelError> {
        if observed_at <= 0 {
            return Err(ManagementChannelError::InvalidObservedAt(observed_at));
        }
        let mut validated = self.validate_envelope(encoded_frame)?;
        if let Err(error) = self.validate_context(&validated) {
            return scrubbed_error(&mut validated, error);
        }
        if validated.header.sent_at_unix_ms > observed_at {
            let sent_at = validated.header.sent_at_unix_ms;
            return scrubbed_error(
                &mut validated,
                ManagementChannelError::InvalidSentAt(sent_at),
            );
        }
        match self
            .history
            .classify(&validated.message_id, &validated.envelope_digest)
        {
            HistoryMatch::Replay { metadata, response } => {
                scrub_envelope(&mut validated);
                return Ok(ManagementReceiverOutcome::Replay { metadata, response });
            }
            HistoryMatch::Conflict => {
                return scrubbed_error(&mut validated, ManagementChannelError::MessageIdConflict);
            }
            HistoryMatch::Tombstone => {
                return scrubbed_error(&mut validated, ManagementChannelError::MessageIdRetired);
            }
            HistoryMatch::Unknown => {}
        }
        if let Some(deadline_at) = validated.header.deadline_at_unix_ms
            && observed_at >= deadline_at
        {
            return scrubbed_error(
                &mut validated,
                ManagementChannelError::DeadlineExpired {
                    deadline_at,
                    observed_at,
                },
            );
        }
        if !self.history.can_track_new() {
            return scrubbed_error(
                &mut validated,
                ManagementChannelError::IdentityCapacityExhausted,
            );
        }
        let Some(expected) = self.last_stream_seq.checked_add(1) else {
            return scrubbed_error(&mut validated, ManagementChannelError::SequenceExhausted);
        };
        if validated.header.stream_seq != expected {
            let actual = validated.header.stream_seq;
            return scrubbed_error(
                &mut validated,
                ManagementChannelError::SequenceMismatch { expected, actual },
            );
        }
        if !payload_allowed(self.context.direction, &validated.body) {
            let error = forbidden_payload(self.context.direction, &validated.body);
            return scrubbed_error(&mut validated, error);
        }
        self.reserve(validated)
    }

    fn validate_envelope(
        &self,
        encoded_frame: &[u8],
    ) -> Result<ValidatedManagementEnvelope, ManagementChannelError> {
        if encoded_frame.len() > self.context.maximum_frame_bytes {
            return Err(ManagementChannelError::FrameTooLarge {
                length: encoded_frame.len(),
                maximum: self.context.maximum_frame_bytes,
            });
        }
        let envelope_digest = management_envelope_sha256(encoded_frame);
        let mut validated = validate_management_frame(encoded_frame)?;
        let header = validate_management_header(
            validated
                .frame
                .header
                .take()
                .ok_or(crate::management_frame::ManagementFrameError::MissingHeader)?,
        )?;
        let body = validated
            .payload
            .body
            .take()
            .ok_or(crate::management_frame::ManagementFrameError::MissingPayloadBody)?;
        let payload_digest = crate::management_frame::management_payload_sha256(
            validated.frame.encoded_payload.as_slice(),
        );
        Ok(ValidatedManagementEnvelope {
            header: header.wire,
            body,
            protocol: header.protocol,
            connection: header.connection,
            message_id: header.message_id,
            payload_digest,
            envelope_digest,
        })
    }

    fn validate_context(
        &self,
        frame: &ValidatedManagementEnvelope,
    ) -> Result<(), ManagementChannelError> {
        if frame.protocol != self.context.protocol {
            return Err(ManagementChannelError::ProtocolMismatch);
        }
        if frame.connection != self.context.connection {
            return Err(ManagementChannelError::ConnectionMismatch);
        }
        Ok(())
    }

    fn reserve(
        &mut self,
        mut frame: ValidatedManagementEnvelope,
    ) -> Result<ManagementReceiverOutcome, ManagementChannelError> {
        let Some(token) = self.next_pending_token.checked_add(1) else {
            return scrubbed_error(&mut frame, ManagementChannelError::PendingTokenExhausted);
        };
        self.next_pending_token = token;
        self.pending = Some(PendingReservation::from_frame(token, &frame));
        Ok(ManagementReceiverOutcome::Pending(Box::new(
            PendingManagementInbound::new(self.receiver_id, token, frame),
        )))
    }

    pub(super) fn poison(&mut self) {
        self.poisoned = true;
        self.pending = None;
        self.history.clear();
    }

    pub(super) const fn has_pending(&self) -> bool {
        self.pending.is_some()
    }

    pub(super) const fn is_poisoned(&self) -> bool {
        self.poisoned
    }

    #[cfg(test)]
    pub(super) fn retained_state(&self) -> (bool, usize, usize, usize) {
        let (active, tombstones, replay_bytes) = self.history.retained_state();
        (self.pending.is_some(), active, tombstones, replay_bytes)
    }
}

fn scrubbed_error(
    frame: &mut ValidatedManagementEnvelope,
    error: ManagementChannelError,
) -> Result<ManagementReceiverOutcome, ManagementChannelError> {
    scrub_envelope(frame);
    Err(error)
}

fn scrub_envelope(frame: &mut ValidatedManagementEnvelope) {
    crate::management_secrets::scrub_protected_body(&mut frame.body);
}
