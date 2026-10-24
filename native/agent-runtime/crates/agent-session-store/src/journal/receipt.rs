use crate::hash::ContentHash;
use crate::record::JournalRecord;
use crate::{
    DurabilityClass, LeaseEpoch, OperationId, SessionId, SessionRecordKind, SessionStoreError,
    StorageGeneration, WriterId,
};

#[derive(Debug, Clone, Copy)]
pub struct AppendRequest<'a> {
    pub operation_id: &'a OperationId,
    pub kind: SessionRecordKind,
    pub durability: DurabilityClass,
    pub payload: &'a [u8],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitReceipt {
    session_id: SessionId,
    operation_id: OperationId,
    storage_generation: StorageGeneration,
    lease_epoch: LeaseEpoch,
    writer_id: WriterId,
    sequence: u64,
    kind: SessionRecordKind,
    durability: DurabilityClass,
    previous_hash: ContentHash,
    payload_hash: ContentHash,
    record_hash: ContentHash,
    payload_bytes: u64,
}

impl CommitReceipt {
    pub(crate) fn from_record(session_id: &SessionId, record: &JournalRecord) -> Self {
        Self {
            session_id: session_id.clone(),
            operation_id: record.operation_id.clone(),
            storage_generation: record.authority.generation(),
            lease_epoch: record.authority.lease_epoch(),
            writer_id: record.authority.writer_id().clone(),
            sequence: record.sequence,
            kind: record.kind,
            durability: record.durability,
            previous_hash: record.previous_hash,
            payload_hash: record.payload_hash,
            record_hash: record.record_hash,
            payload_bytes: record.payload_bytes,
        }
    }

    #[must_use]
    pub const fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    #[must_use]
    pub const fn operation_id(&self) -> &OperationId {
        &self.operation_id
    }

    #[must_use]
    pub const fn storage_generation(&self) -> StorageGeneration {
        self.storage_generation
    }

    #[must_use]
    pub const fn lease_epoch(&self) -> LeaseEpoch {
        self.lease_epoch
    }

    #[must_use]
    pub const fn writer_id(&self) -> &WriterId {
        &self.writer_id
    }

    #[must_use]
    pub const fn sequence(&self) -> u64 {
        self.sequence
    }

    #[must_use]
    pub const fn kind(&self) -> SessionRecordKind {
        self.kind
    }

    #[must_use]
    pub const fn durability(&self) -> DurabilityClass {
        self.durability
    }

    #[must_use]
    pub const fn previous_hash(&self) -> ContentHash {
        self.previous_hash
    }

    #[must_use]
    pub const fn payload_hash(&self) -> ContentHash {
        self.payload_hash
    }

    #[must_use]
    pub const fn record_hash(&self) -> ContentHash {
        self.record_hash
    }

    #[must_use]
    pub const fn payload_bytes(&self) -> u64 {
        self.payload_bytes
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommitOutcome {
    Committed(CommitReceipt),
    Replay(CommitReceipt),
}

impl CommitOutcome {
    #[must_use]
    pub const fn receipt(&self) -> &CommitReceipt {
        match self {
            Self::Committed(receipt) | Self::Replay(receipt) => receipt,
        }
    }
}

pub(super) fn replay(
    stored: &CommitReceipt,
    kind: SessionRecordKind,
    durability: DurabilityClass,
    payload_hash: ContentHash,
    payload_bytes: u64,
) -> Result<CommitOutcome, SessionStoreError> {
    if stored.kind() == kind
        && stored.durability() == durability
        && stored.payload_hash() == payload_hash
        && stored.payload_bytes() == payload_bytes
    {
        return Ok(CommitOutcome::Replay(stored.clone()));
    }
    Err(SessionStoreError::DivergentReplay)
}
