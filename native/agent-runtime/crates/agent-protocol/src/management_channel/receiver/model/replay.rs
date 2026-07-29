use std::fmt::{self, Debug, Formatter};
use std::sync::Arc;

use super::PendingManagementInbound;

#[derive(Clone, PartialEq, Eq)]
pub(in crate::management_channel::receiver) enum ReplayDisposition {
    Accepted,
    Response(Arc<[u8]>),
}

impl ReplayDisposition {
    pub(in crate::management_channel::receiver) fn response_allocation(
        &self,
    ) -> Option<(usize, usize)> {
        match self {
            Self::Accepted => None,
            Self::Response(bytes) => Some((bytes.as_ptr() as usize, bytes.len())),
        }
    }

    pub(in crate::management_channel::receiver) fn shared_response(&self) -> Option<Arc<[u8]>> {
        match self {
            Self::Accepted => None,
            Self::Response(bytes) => Some(Arc::clone(bytes)),
        }
    }
}

impl Debug for ReplayDisposition {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Accepted => formatter.write_str("Accepted"),
            Self::Response(bytes) => formatter
                .debug_struct("Response")
                .field("encoded_length", &bytes.len())
                .field("encoded", &"[REDACTED]")
                .finish(),
        }
    }
}

pub enum ManagementReceiveOutcome {
    Pending(Box<PendingManagementInbound>),
    Replay(ReplayedManagementFrame),
}

pub(in crate::management_channel) enum ManagementReceiverOutcome {
    Pending(Box<PendingManagementInbound>),
    Replay {
        metadata: ReplayedManagementFrame,
        response: Option<Arc<[u8]>>,
    },
}

impl Debug for ManagementReceiveOutcome {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Pending(pending) => formatter.debug_tuple("Pending").field(pending).finish(),
            Self::Replay(replay) => formatter.debug_tuple("Replay").field(replay).finish(),
        }
    }
}

#[derive(Clone)]
pub struct ReplayedManagementFrame {
    message_id: String,
    stream_seq: u64,
    envelope_digest: [u8; 32],
}

impl Debug for ReplayedManagementFrame {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReplayedManagementFrame")
            .field("message_id", &self.message_id)
            .field("stream_seq", &self.stream_seq)
            .field("envelope_digest", &self.envelope_digest)
            .finish()
    }
}

impl ReplayedManagementFrame {
    pub(in crate::management_channel::receiver) const fn new(
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
