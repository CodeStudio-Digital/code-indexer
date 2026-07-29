use super::SessionJournal;
use crate::{CommittedPayload, ReadCommittedPayloadRequest, SessionStoreError};

impl SessionJournal {
    /// Reads a payload only when the exact operation, kind, hash, and length
    /// were committed under the current physical writer lease.
    ///
    /// # Errors
    ///
    /// Rejects stale authority, unknown operations, divergent metadata,
    /// payloads above either bound, unsafe files, and hash/length mismatches.
    pub fn read_committed_payload(
        &mut self,
        request: ReadCommittedPayloadRequest<'_>,
    ) -> Result<CommittedPayload, SessionStoreError> {
        self.verify_authority()?;
        if request.expected_payload_bytes > request.maximum_payload_bytes
            || request.expected_payload_bytes > self.limits.max_payload_bytes()
        {
            return Err(SessionStoreError::PayloadLimitExceeded);
        }
        let receipt = {
            let stored = self
                .state
                .operations
                .get(request.operation_id)
                .ok_or(SessionStoreError::MissingPayload)?;
            let receipt = &stored.receipt;
            if receipt.kind() != request.kind
                || receipt.payload_hash() != request.expected_payload_sha256
                || receipt.payload_bytes() != request.expected_payload_bytes
            {
                return Err(SessionStoreError::DivergentReplay);
            }
            receipt.clone()
        };
        let encoded_payload = crate::payload::read_payload(
            &self.layout,
            request.kind,
            &request.expected_payload_sha256,
            request.expected_payload_bytes,
            request.maximum_payload_bytes,
        )?;
        Ok(CommittedPayload::new(receipt, encoded_payload))
    }
}
