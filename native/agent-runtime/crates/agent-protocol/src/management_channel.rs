//! Transactional, bounded host-supervisor management transport.
//!
//! This channel carries only the physical lifecycle messages present in
//! `ManagementPayload`; attempt-domain content has no representation here.
//!
//! The async established actor can only be returned by the bootstrap owner
//! after both physical Hello frames validate on the same stream. Its public
//! surface exposes bounded command and event ports, never the raw stream or
//! sequence authorities.

use crate::generated::v1 as wire;
use crate::identity::ConnectionId;
use crate::management_frame::MANAGEMENT_FRAME_MAX_BYTES;
use crate::version::ProtocolVersion;

mod async_actor;
mod bootstrap;
mod channel;
mod clock;
mod correlation;
mod deadline;
mod direction;
mod error;
mod header;
mod payload;
mod receiver;
mod sender;

pub use async_actor::{
    AsyncAcknowledgedManagementInbound, AsyncBootstrapManagementActor,
    AsyncEstablishedManagementActor, AsyncManagementActorError, AsyncManagementCommandPort,
    AsyncManagementEvent, AsyncManagementPolicy, AsyncPendingManagementInbound,
    AsyncQueuedManagementWrite, AsyncSentManagementFrame,
};
pub use bootstrap::{
    BootstrapManagementChannel, ManagementBootstrapHello, ManagementSessionPolicy,
};
pub use channel::{EstablishedManagementChannel, ManagementChannelResponse, SentManagementFrame};
pub use deadline::ManagementDeadlinePolicy;
pub use direction::ManagementDirection;
pub use error::ManagementChannelError;
pub use payload::ManagementPayloadKind;
pub use receiver::{
    CommittedManagementInbound, ManagementInboundBinding, ManagementReceiveOutcome,
    PendingManagementInbound, ReplayedManagementFrame, ValidatedManagementPayload,
};

pub const MAX_MANAGEMENT_REPLAY_ENTRIES: usize = 512;
pub const MAX_MANAGEMENT_TRACKED_IDS: usize = 8_192;
pub const MAX_MANAGEMENT_REPLAY_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ManagementReplayLimits {
    pub entries: usize,
    pub tracked_message_ids: usize,
    pub bytes: usize,
}

impl ManagementReplayLimits {
    /// Creates explicit count, tombstone, and physical-byte replay bounds.
    ///
    /// # Errors
    ///
    /// Rejects empty, inverted, or implementation-exceeding limits.
    pub const fn new(
        entries: usize,
        tracked_message_ids: usize,
        bytes: usize,
    ) -> Result<Self, ManagementChannelError> {
        if entries == 0 || entries > MAX_MANAGEMENT_REPLAY_ENTRIES {
            return Err(ManagementChannelError::InvalidReplayLimits);
        }
        if tracked_message_ids < entries
            || tracked_message_ids > MAX_MANAGEMENT_TRACKED_IDS
            || bytes == 0
            || bytes > MAX_MANAGEMENT_REPLAY_BYTES
        {
            return Err(ManagementChannelError::InvalidReplayLimits);
        }
        Ok(Self {
            entries,
            tracked_message_ids,
            bytes,
        })
    }
}

#[derive(Debug, Clone)]
struct ManagementReceiverContext {
    protocol: ProtocolVersion,
    connection: ConnectionId,
    direction: ManagementDirection,
    maximum_frame_bytes: usize,
    bootstrap_message_id: String,
}

struct ValidatedManagementEnvelope {
    header: wire::ManagementFrameHeader,
    body: wire::management_payload::Body,
    protocol: ProtocolVersion,
    connection: ConnectionId,
    message_id: String,
    payload_digest: [u8; 32],
    envelope_digest: [u8; 32],
}

const fn management_hard_cap() -> usize {
    MANAGEMENT_FRAME_MAX_BYTES
}

#[cfg(test)]
mod tests;
