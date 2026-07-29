use std::fmt::{self, Debug, Formatter};
use std::io::{Read, Write};

use crate::framing::{DelimitedFrameChannel, FramingError};

use super::clock::ManagementClockAuthority;
use super::receiver::ManagementReceiver;
use super::sender::ManagementOutboundAuthority;
use super::{
    CommittedManagementInbound, ManagementChannelError, ManagementSessionPolicy,
    PendingManagementInbound,
};

mod inbound;
mod outbound;
pub(in crate::management_channel) mod validation;

pub struct ManagementChannelResponse {
    receipt: CommittedManagementInbound,
    sent: SentManagementFrame,
}

impl Debug for ManagementChannelResponse {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ManagementChannelResponse")
            .field("receipt", &self.receipt)
            .field("sent", &self.sent)
            .finish()
    }
}

impl ManagementChannelResponse {
    #[must_use]
    pub fn into_receipt(self) -> CommittedManagementInbound {
        self.receipt
    }

    /// Returns non-authoritative correlation metadata for the frame that was
    /// physically committed by this response.
    #[must_use]
    pub const fn sent_frame(&self) -> &SentManagementFrame {
        &self.sent
    }
}

pub struct SentManagementFrame {
    stream_seq: u64,
    message_id: String,
    payload_digest: [u8; 32],
}

impl Debug for SentManagementFrame {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SentManagementFrame")
            .field("stream_seq", &self.stream_seq)
            .field("message_id", &self.message_id)
            .field("payload_digest", &"[REDACTED]")
            .finish()
    }
}

impl SentManagementFrame {
    #[must_use]
    pub const fn stream_seq(&self) -> u64 {
        self.stream_seq
    }

    #[must_use]
    pub fn message_id(&self) -> &str {
        &self.message_id
    }

    #[must_use]
    pub const fn payload_digest(&self) -> &[u8; 32] {
        &self.payload_digest
    }
}

/// Sole owner of an established physical management stream and both sequence
/// authorities.
///
/// External callers provide only payload plus a relative deadline policy:
///
/// ```compile_fail
/// use std::io::{Read, Write};
/// use agent_protocol::generated::v1::ManagementPayload;
/// use agent_protocol::management_channel::{
///     EstablishedManagementChannel, ManagementDeadlinePolicy,
/// };
///
/// fn bypass<R: Read, W: Write>(
///     channel: &mut EstablishedManagementChannel<R, W>,
///     payload: &ManagementPayload,
///     policy: ManagementDeadlinePolicy,
/// ) {
///     let _ = channel.send_new(payload, policy, || 1);
/// }
/// ```
pub struct EstablishedManagementChannel<R, W> {
    transport: DelimitedFrameChannel<R, W>,
    receiver: ManagementReceiver,
    sender: ManagementOutboundAuthority,
    policy: ManagementSessionPolicy,
    clock: ManagementClockAuthority,
}

impl<R: Read, W: Write> Debug for EstablishedManagementChannel<R, W> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EstablishedManagementChannel")
            .field("transport", &self.transport)
            .field("poisoned", &self.is_poisoned())
            .field("policy", &self.policy)
            .finish_non_exhaustive()
    }
}

impl<R: Read, W: Write> EstablishedManagementChannel<R, W> {
    pub(super) fn from_handoff(
        mut transport: DelimitedFrameChannel<R, W>,
        receiver: ManagementReceiver,
        sender: ManagementOutboundAuthority,
        policy: ManagementSessionPolicy,
        clock: ManagementClockAuthority,
    ) -> Result<Self, ManagementChannelError> {
        let physical = transport.maximum_frame_bytes();
        if usize::try_from(physical).unwrap_or(usize::MAX) != receiver.maximum_frame_bytes() {
            transport.poison();
            return Err(ManagementChannelError::PhysicalCapMismatch {
                physical,
                required: receiver.maximum_frame_bytes(),
            });
        }
        Ok(Self {
            transport,
            receiver,
            sender,
            policy,
            clock,
        })
    }

    /// Commits an inbound transaction that needs no physical response.
    ///
    /// # Errors
    ///
    /// Foreign or stale pending authority poisons the channel.
    pub fn commit_accepted(
        &mut self,
        inbound: PendingManagementInbound,
    ) -> Result<CommittedManagementInbound, ManagementChannelError> {
        if inbound.kind() != crate::management_channel::ManagementPayloadKind::ManagementAck {
            let error = ManagementChannelError::InvalidResponseCorrelation {
                inbound: inbound.kind().name(),
                outbound: "None",
            };
            self.poison_all();
            return Err(error);
        }
        let reply_to = inbound.reply_to_message_id().map(str::to_owned);
        let receipt = self.receiver.commit(inbound, None).inspect_err(|_| {
            self.transport.poison();
            self.sender.poison();
        })?;
        self.sender.complete_inbound_response(reply_to.as_deref());
        Ok(receipt)
    }

    /// Rejects work and makes both directions unusable.
    ///
    /// # Errors
    ///
    /// Returns an authority error for foreign pending work.
    pub fn reject(
        &mut self,
        inbound: PendingManagementInbound,
    ) -> Result<(), ManagementChannelError> {
        let result = self.receiver.reject(inbound);
        self.transport.poison();
        self.sender.poison();
        result
    }

    #[must_use]
    pub const fn is_poisoned(&self) -> bool {
        self.transport.is_poisoned() || self.receiver.is_poisoned() || self.sender.is_poisoned()
    }

    #[must_use]
    pub const fn policy(&self) -> &ManagementSessionPolicy {
        &self.policy
    }

    /// Samples the channel-owned monotonic Unix clock for typed facade facts.
    #[must_use]
    pub fn owner_now_unix_ms(&self) -> i64 {
        self.clock.now_unix_ms()
    }

    #[cfg(test)]
    pub(super) fn retained_state(&self) -> (bool, usize, usize, usize, bool, usize, usize) {
        let (pending, active, tombstones, replay_bytes) = self.receiver.retained_state();
        let (outstanding, outstanding_bytes) = self.sender.retained_outstanding();
        (
            pending,
            active,
            tombstones,
            replay_bytes,
            self.sender.has_pending(),
            outstanding,
            outstanding_bytes,
        )
    }

    fn poison_all(&mut self) {
        self.transport.poison();
        self.receiver.poison();
        self.sender.poison();
    }
}

impl From<FramingError> for ManagementChannelError {
    fn from(value: FramingError) -> Self {
        Self::Framing(value)
    }
}
