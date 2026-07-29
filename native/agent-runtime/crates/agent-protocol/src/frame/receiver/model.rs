use std::fmt::{self, Debug, Formatter};
use std::sync::Arc;

use crate::generated::v1 as wire;
use crate::identity::AttemptIdentity;

use super::super::ValidatedAttemptFrame;
use super::error::InboundFrameError;
use super::receipt::InboundBinding;

#[derive(Clone, PartialEq, Eq)]
enum ReplayOutcomeValue {
    Accepted,
    Response(Arc<[u8]>),
}

#[derive(Clone, PartialEq, Eq)]
pub struct BoundedReplayOutcome {
    value: ReplayOutcomeValue,
}

impl Debug for BoundedReplayOutcome {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        let (kind, response_bytes) = match &self.value {
            ReplayOutcomeValue::Accepted => ("accepted", None),
            ReplayOutcomeValue::Response(bytes) => ("response", Some(bytes.len())),
        };
        formatter
            .debug_struct("BoundedReplayOutcome")
            .field("kind", &kind)
            .field("response_bytes", &response_bytes)
            .finish_non_exhaustive()
    }
}

impl BoundedReplayOutcome {
    #[must_use]
    pub const fn accepted() -> Self {
        Self {
            value: ReplayOutcomeValue::Accepted,
        }
    }

    pub(super) fn response(bytes: Vec<u8>) -> Self {
        Self {
            value: ReplayOutcomeValue::Response(bytes.into()),
        }
    }

    pub(in crate::frame) const fn from_shared_response(bytes: Arc<[u8]>) -> Self {
        Self {
            value: ReplayOutcomeValue::Response(bytes),
        }
    }

    #[must_use]
    pub fn response_bytes(&self) -> Option<&[u8]> {
        match &self.value {
            ReplayOutcomeValue::Accepted => None,
            ReplayOutcomeValue::Response(bytes) => Some(bytes),
        }
    }

    pub(super) fn response_allocation(&self) -> Option<(usize, usize)> {
        match &self.value {
            ReplayOutcomeValue::Accepted => None,
            ReplayOutcomeValue::Response(bytes) => Some((bytes.as_ptr() as usize, bytes.len())),
        }
    }

    pub(super) fn shared_response(&self) -> Option<Arc<[u8]>> {
        match &self.value {
            ReplayOutcomeValue::Accepted => None,
            ReplayOutcomeValue::Response(bytes) => Some(Arc::clone(bytes)),
        }
    }
}

#[derive(Debug)]
pub enum FrameReceiveOutcome {
    Pending(Box<PendingInbound>),
    Replay(ReplayedFrame),
}

#[derive(Debug, Clone)]
pub struct ReplayedFrame {
    message_id: String,
    stream_seq: u64,
    envelope_digest: [u8; 32],
}

impl ReplayedFrame {
    pub(super) const fn new(
        message_id: String,
        stream_seq: u64,
        envelope_digest: [u8; 32],
    ) -> Self {
        Self {
            message_id,
            stream_seq,
            envelope_digest,
        }
    }

    #[must_use]
    pub fn message_id(&self) -> &str {
        &self.message_id
    }

    #[must_use]
    pub const fn stream_seq(&self) -> u64 {
        self.stream_seq
    }

    #[must_use]
    pub const fn envelope_digest(&self) -> &[u8; 32] {
        &self.envelope_digest
    }
}

pub struct PendingInbound {
    pub(super) receiver_id: u64,
    pub(super) token: u64,
    pub(super) message_id: String,
    pub(super) stream_seq: u64,
    pub(super) envelope_digest: [u8; 32],
    header: wire::FrameHeader,
    channel: wire::TransportChannel,
    body: Option<wire::frame_payload::Body>,
    identity: AttemptIdentity,
    payload_digest: [u8; 32],
}

impl Debug for PendingInbound {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingInbound")
            .field("message_id", &self.message_id)
            .field("stream_seq", &self.stream_seq)
            .field("channel", &self.channel)
            .field(
                "payload",
                &self.body.as_ref().map(super::super::channel::payload_name),
            )
            .field("identity", &self.identity)
            .field("payload_digest", &self.payload_digest)
            .field("body", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}

impl PendingInbound {
    pub(super) fn new(
        receiver_id: u64,
        token: u64,
        message_id: String,
        stream_seq: u64,
        envelope_digest: [u8; 32],
        inner: ValidatedAttemptFrame,
    ) -> Self {
        let ValidatedAttemptFrame {
            header,
            channel,
            body,
            identity,
            payload_digest,
            ..
        } = inner;
        Self {
            receiver_id,
            token,
            message_id,
            stream_seq,
            envelope_digest,
            header,
            channel,
            body: Some(body),
            identity,
            payload_digest,
        }
    }

    #[must_use]
    pub const fn header(&self) -> &wire::FrameHeader {
        &self.header
    }

    #[must_use]
    pub const fn channel(&self) -> wire::TransportChannel {
        self.channel
    }

    #[must_use]
    pub const fn identity(&self) -> &AttemptIdentity {
        &self.identity
    }

    pub(in crate::frame) fn message_id(&self) -> &str {
        &self.message_id
    }

    #[must_use]
    pub fn binding(&self) -> InboundBinding {
        InboundBinding::new(
            self.receiver_id,
            self.token,
            self.message_id.clone(),
            self.stream_seq,
            self.envelope_digest,
        )
    }

    /// Moves the decoded payload and its verified digest exactly once.
    ///
    /// # Errors
    ///
    /// Returns [`InboundFrameError::PendingPayloadConsumed`] after the first
    /// successful take.
    pub fn take_body_and_digest(
        &mut self,
    ) -> Result<(wire::frame_payload::Body, [u8; 32]), InboundFrameError> {
        let body = self
            .body
            .take()
            .ok_or(InboundFrameError::PendingPayloadConsumed)?;
        Ok((body, self.payload_digest))
    }
}
