//! Bounded, single-writer filesystem persistence for agent sessions.
//!
//! This crate owns physical bundle commits. It deliberately has no dependency
//! on the agent engine, runner, supervisor, provider, `SQLite`, or UI.

mod authority;
mod authority_log;
mod committed_payload;
mod durability;
mod error;
mod hash;
mod id;
mod journal;
mod kind;
mod layout;
mod lease;
mod limits;
mod manifest;
mod payload;
mod read_view;
mod record;
mod recovery;
mod root_lock;
mod state;
mod transfer;

pub use authority::{LeaseEpoch, StorageAuthority, StorageGeneration};
pub use committed_payload::{CommittedPayload, ReadCommittedPayloadRequest};
pub use durability::DurabilityClass;
pub use error::SessionStoreError;
pub use id::{OperationId, SessionId, WriterId};
pub use journal::{
    AppendRequest, CommitOutcome, CommitReceipt, CommittedRecordPage, ListCommittedRecordsRequest,
    MAX_COMMITTED_RECORD_PAGE, SessionJournal,
};
pub use kind::SessionRecordKind;
pub use limits::SessionStoreLimits;
pub use read_view::SessionReadView;
pub use root_lock::StorageRootLock;
pub use state::SessionStateSnapshot;
pub use transfer::{
    LegacyStorageTransferReceipt, LegacyStorageTransferRequest, LegacyTransferLimits,
    StorageTransferFaultInjector, StorageTransferFaultPoint, transfer_typescript_bundle,
    transfer_typescript_bundle_with_faults, verify_typescript_bundle_manifest,
};
