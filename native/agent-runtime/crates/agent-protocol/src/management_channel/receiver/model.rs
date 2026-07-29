use crate::generated::v1 as wire;
use std::fmt::{self, Debug, Formatter};

use super::super::{ManagementChannelError, ValidatedManagementEnvelope};
use crate::management_channel::correlation::LaunchCorrelation;
use crate::management_channel::payload::ManagementPayloadKind;

mod payload;
mod replay;

pub use payload::ValidatedManagementPayload;
pub(in crate::management_channel) use replay::ManagementReceiverOutcome;
pub(in crate::management_channel::receiver) use replay::ReplayDisposition;
pub use replay::{ManagementReceiveOutcome, ReplayedManagementFrame};

/// Non-cloneable transaction authority with an opaque validated payload.
///
/// Raw generated oneof bodies cannot be extracted from the authority:
///
/// ```compile_fail
/// use agent_protocol::management_channel::PendingManagementInbound;
///
/// fn bypass(mut pending: PendingManagementInbound) {
///     let _ = pending.take_body_and_digest();
/// }
/// ```
pub struct PendingManagementInbound {
    receiver_id: u64,
    token: u64,
    message_id: String,
    stream_seq: u64,
    envelope_digest: [u8; 32],
    header: wire::ManagementFrameHeader,
    body: Option<wire::management_payload::Body>,
    kind: ManagementPayloadKind,
    payload_digest: [u8; 32],
    launch_correlation: Option<LaunchCorrelation>,
}

impl Debug for PendingManagementInbound {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingManagementInbound")
            .field("message_id", &self.message_id)
            .field("stream_seq", &self.stream_seq)
            .field("body_kind", &self.kind.name())
            .field("payload", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}

impl PendingManagementInbound {
    pub(super) fn new(receiver_id: u64, token: u64, frame: ValidatedManagementEnvelope) -> Self {
        let kind = ManagementPayloadKind::from_body(&frame.body);
        let launch_correlation = match &frame.body {
            wire::management_payload::Body::LaunchAttemptProcess(value) => {
                LaunchCorrelation::from_launch(value)
            }
            _ => None,
        };
        Self {
            receiver_id,
            token,
            message_id: frame.message_id,
            stream_seq: frame.header.stream_seq,
            envelope_digest: frame.envelope_digest,
            header: frame.header,
            body: Some(frame.body),
            kind,
            payload_digest: frame.payload_digest,
            launch_correlation,
        }
    }

    #[must_use]
    pub const fn header(&self) -> &wire::ManagementFrameHeader {
        &self.header
    }

    #[must_use]
    pub fn binding(&self) -> ManagementInboundBinding {
        ManagementInboundBinding {
            receiver_id: self.receiver_id,
            token: self.token,
            message_id: self.message_id.clone(),
            stream_seq: self.stream_seq,
            envelope_digest: self.envelope_digest,
        }
    }

    /// Moves the validated payload and verified payload digest once.
    ///
    /// # Errors
    ///
    /// Rejects a second take from the same transaction.
    pub fn take_validated_payload_and_digest(
        &mut self,
    ) -> Result<(ValidatedManagementPayload, [u8; 32]), ManagementChannelError> {
        let body = self
            .body
            .take()
            .ok_or(ManagementChannelError::PendingPayloadConsumed)?;
        Ok((ValidatedManagementPayload::new(body), self.payload_digest))
    }

    pub(in crate::management_channel) fn message_id(&self) -> &str {
        &self.message_id
    }

    pub(in crate::management_channel) const fn kind(&self) -> ManagementPayloadKind {
        self.kind
    }

    pub(in crate::management_channel) const fn body(
        &self,
    ) -> Option<&wire::management_payload::Body> {
        self.body.as_ref()
    }

    pub(in crate::management_channel) fn reply_to_message_id(&self) -> Option<&str> {
        self.header.reply_to_message_id.as_deref()
    }

    pub(in crate::management_channel) const fn payload_digest(&self) -> &[u8; 32] {
        &self.payload_digest
    }

    pub(in crate::management_channel) const fn launch_correlation(
        &self,
    ) -> Option<&LaunchCorrelation> {
        self.launch_correlation.as_ref()
    }
}

impl Drop for PendingManagementInbound {
    fn drop(&mut self) {
        if let Some(body) = &mut self.body {
            crate::management_secrets::scrub_protected_body(body);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagementInboundBinding {
    pub(super) receiver_id: u64,
    pub(super) token: u64,
    pub(super) message_id: String,
    pub(super) stream_seq: u64,
    pub(super) envelope_digest: [u8; 32],
}

#[derive(Debug, PartialEq, Eq)]
pub struct CommittedManagementInbound {
    binding: ManagementInboundBinding,
}

impl CommittedManagementInbound {
    pub(super) const fn new(binding: ManagementInboundBinding) -> Self {
        Self { binding }
    }

    #[must_use]
    pub const fn binding(&self) -> &ManagementInboundBinding {
        &self.binding
    }

    #[must_use]
    pub fn message_id(&self) -> &str {
        &self.binding.message_id
    }

    #[must_use]
    pub const fn stream_seq(&self) -> u64 {
        self.binding.stream_seq
    }
}

#[derive(Debug)]
pub(super) struct PendingReservation {
    pub token: u64,
    pub message_id: String,
    pub stream_seq: u64,
    pub envelope_digest: [u8; 32],
}

impl PendingReservation {
    pub(super) fn from_frame(token: u64, frame: &ValidatedManagementEnvelope) -> Self {
        Self {
            token,
            message_id: frame.message_id.clone(),
            stream_seq: frame.header.stream_seq,
            envelope_digest: frame.envelope_digest,
        }
    }
}
