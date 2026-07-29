use std::fmt::Debug;

use crate::hash::ContentHash;
use crate::{
    SessionId, SessionStoreError, SessionStoreLimits, StorageAuthority, StorageGeneration,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LegacyTransferLimits {
    pub(super) max_files: u64,
    pub(super) max_file_bytes: u64,
    pub(super) max_total_bytes: u64,
    pub(super) journal: SessionStoreLimits,
}

impl LegacyTransferLimits {
    /// Creates simultaneous legacy-inventory and new-journal bounds.
    ///
    /// # Errors
    ///
    /// Rejects zero or platform-unaddressable bounds.
    pub fn new(
        max_files: u64,
        max_file_bytes: u64,
        max_total_bytes: u64,
        journal: SessionStoreLimits,
    ) -> Result<Self, SessionStoreError> {
        if max_files == 0
            || max_file_bytes == 0
            || max_total_bytes == 0
            || usize::try_from(max_files).is_err()
        {
            return Err(SessionStoreError::InvalidLimits);
        }
        Ok(Self {
            max_files,
            max_file_bytes,
            max_total_bytes,
            journal,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyStorageTransferRequest {
    pub session_id: SessionId,
    pub expected_source_lease_epoch: u64,
    pub next_authority: StorageAuthority,
    pub verified_manifest_sha256: ContentHash,
    pub idempotency_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyStorageTransferReceipt {
    pub session_id: SessionId,
    pub source_generation: StorageGeneration,
    pub activated_authority: StorageAuthority,
    pub verified_manifest_sha256: ContentHash,
    pub activation_receipt_sha256: ContentHash,
    pub replay: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageTransferFaultPoint {
    GuardDurable,
    StageVerified,
    SourceMoved,
    Activated,
}

pub trait StorageTransferFaultInjector: Debug {
    /// # Errors
    ///
    /// A returned error models an abrupt stop at a durability barrier.
    fn inject(&mut self, point: StorageTransferFaultPoint) -> Result<(), SessionStoreError>;
}
