use std::sync::Arc;

use super::super::CommittedInbound;

#[derive(Debug)]
pub(super) struct OutboundReservation {
    pub token: u64,
    pub stream_seq: u64,
    pub allocation: usize,
}

#[derive(Debug)]
pub(in crate::frame) struct PendingOutbound {
    pub(super) sender_id: u64,
    pub(super) token: u64,
    pub(super) stream_seq: u64,
    pub(super) encoded: Arc<[u8]>,
    pub(super) message_id: String,
    pub(super) payload_digest: [u8; 32],
    pub(super) sent_at_unix_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommittedOutbound {
    message_id: String,
    stream_seq: u64,
    payload_digest: [u8; 32],
    sent_at_unix_ms: i64,
}

impl CommittedOutbound {
    pub(super) fn from_pending(pending: &PendingOutbound) -> Self {
        Self {
            message_id: pending.message_id.clone(),
            stream_seq: pending.stream_seq,
            payload_digest: pending.payload_digest,
            sent_at_unix_ms: pending.sent_at_unix_ms,
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
    pub const fn payload_digest(&self) -> &[u8; 32] {
        &self.payload_digest
    }

    #[must_use]
    pub const fn sent_at_unix_ms(&self) -> i64 {
        self.sent_at_unix_ms
    }
}

impl PendingOutbound {
    pub(in crate::frame) fn shared(&self) -> Arc<[u8]> {
        Arc::clone(&self.encoded)
    }

    pub(in crate::frame) fn into_stream_seq(self) -> u64 {
        self.stream_seq
    }
}

#[derive(Debug)]
pub struct CommittedResponse {
    receipt: CommittedInbound,
}

impl CommittedResponse {
    pub(in crate::frame) const fn new(receipt: CommittedInbound) -> Self {
        Self { receipt }
    }

    #[must_use]
    pub fn into_receipt(self) -> CommittedInbound {
        self.receipt
    }
}
