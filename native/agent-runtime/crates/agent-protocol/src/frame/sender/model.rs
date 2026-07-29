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
