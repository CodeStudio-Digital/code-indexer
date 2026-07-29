use crate::{SessionId, StorageAuthority};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionStateSnapshot {
    session_id: SessionId,
    authority: StorageAuthority,
    committed_records: u64,
    last_commit_hash: [u8; 32],
    archived: bool,
}

impl SessionStateSnapshot {
    pub(crate) const fn new(
        session_id: SessionId,
        authority: StorageAuthority,
        committed_records: u64,
        last_commit_hash: [u8; 32],
        archived: bool,
    ) -> Self {
        Self {
            session_id,
            authority,
            committed_records,
            last_commit_hash,
            archived,
        }
    }

    #[must_use]
    pub const fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    #[must_use]
    pub const fn authority(&self) -> &StorageAuthority {
        &self.authority
    }

    #[must_use]
    pub const fn committed_records(&self) -> u64 {
        self.committed_records
    }

    #[must_use]
    pub const fn last_commit_hash(&self) -> [u8; 32] {
        self.last_commit_hash
    }

    #[must_use]
    pub const fn archived(&self) -> bool {
        self.archived
    }
}
