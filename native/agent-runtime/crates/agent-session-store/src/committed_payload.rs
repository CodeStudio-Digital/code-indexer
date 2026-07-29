use std::fmt::{self, Debug, Formatter};

use crate::{CommitReceipt, OperationId, SessionRecordKind};

/// Exact identity of a payload that must already exist in the fenced journal.
#[derive(Debug, Clone, Copy)]
pub struct ReadCommittedPayloadRequest<'a> {
    pub operation_id: &'a OperationId,
    pub kind: SessionRecordKind,
    pub expected_payload_sha256: [u8; 32],
    pub expected_payload_bytes: u64,
    pub maximum_payload_bytes: u64,
}

/// Verified bytes and the durable commit that authorized their read.
pub struct CommittedPayload {
    receipt: CommitReceipt,
    encoded_payload: Vec<u8>,
}

impl CommittedPayload {
    pub(crate) const fn new(receipt: CommitReceipt, encoded_payload: Vec<u8>) -> Self {
        Self {
            receipt,
            encoded_payload,
        }
    }

    #[must_use]
    pub const fn receipt(&self) -> &CommitReceipt {
        &self.receipt
    }

    #[must_use]
    pub fn encoded_payload(&self) -> &[u8] {
        &self.encoded_payload
    }

    #[must_use]
    pub fn into_parts(self) -> (CommitReceipt, Vec<u8>) {
        (self.receipt, self.encoded_payload)
    }
}

impl Debug for CommittedPayload {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CommittedPayload")
            .field("receipt", &self.receipt)
            .field("payload_bytes", &self.encoded_payload.len())
            .field("encoded_payload", &"[REDACTED]")
            .finish()
    }
}
