use crate::SessionStoreError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionStoreLimits {
    records: u64,
    payload_bytes: u64,
    authority_transitions: u64,
}

impl SessionStoreLimits {
    /// Creates simultaneous record-count and per-payload bounds.
    ///
    /// # Errors
    ///
    /// Returns [`SessionStoreError::InvalidLimits`] for zero or unaddressable
    /// limits.
    pub fn new(
        max_records: u64,
        max_payload_bytes: u64,
        max_authority_transitions: u64,
    ) -> Result<Self, SessionStoreError> {
        if max_records == 0
            || max_payload_bytes == 0
            || max_authority_transitions == 0
            || usize::try_from(max_records).is_err()
            || usize::try_from(max_authority_transitions).is_err()
        {
            return Err(SessionStoreError::InvalidLimits);
        }
        Ok(Self {
            records: max_records,
            payload_bytes: max_payload_bytes,
            authority_transitions: max_authority_transitions,
        })
    }

    pub(crate) const fn max_records(self) -> u64 {
        self.records
    }

    pub(crate) const fn max_payload_bytes(self) -> u64 {
        self.payload_bytes
    }

    pub(crate) const fn max_authority_transitions(self) -> u64 {
        self.authority_transitions
    }
}
