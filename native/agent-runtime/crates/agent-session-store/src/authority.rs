use crate::{SessionStoreError, WriterId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StorageGeneration {
    TypescriptFsV1,
    RustFsV1,
}

impl StorageGeneration {
    pub(crate) const fn name(self) -> &'static str {
        match self {
            Self::TypescriptFsV1 => "typescript_fs_v1",
            Self::RustFsV1 => "rust_fs_v1",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, SessionStoreError> {
        match value {
            "rust_fs_v1" => Ok(Self::RustFsV1),
            _ => Err(SessionStoreError::CorruptAuthority),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct LeaseEpoch(u64);

impl LeaseEpoch {
    /// Creates a positive storage-writer fencing epoch.
    ///
    /// # Errors
    ///
    /// Returns [`SessionStoreError::InvalidLeaseEpoch`] for zero.
    pub const fn new(value: u64) -> Result<Self, SessionStoreError> {
        if value == 0 {
            return Err(SessionStoreError::InvalidLeaseEpoch);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }

    pub(crate) fn next(self) -> Result<Self, SessionStoreError> {
        let value = self
            .0
            .checked_add(1)
            .ok_or(SessionStoreError::AuthorityGap)?;
        Self::new(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct StorageAuthority {
    generation: StorageGeneration,
    lease_epoch: LeaseEpoch,
    writer_id: WriterId,
}

impl StorageAuthority {
    #[must_use]
    pub const fn rust_fs_v1(lease_epoch: LeaseEpoch, writer_id: WriterId) -> Self {
        Self {
            generation: StorageGeneration::RustFsV1,
            lease_epoch,
            writer_id,
        }
    }

    pub(crate) const fn from_parts(
        generation: StorageGeneration,
        lease_epoch: LeaseEpoch,
        writer_id: WriterId,
    ) -> Self {
        Self {
            generation,
            lease_epoch,
            writer_id,
        }
    }

    #[must_use]
    pub const fn generation(&self) -> StorageGeneration {
        self.generation
    }

    #[must_use]
    pub const fn lease_epoch(&self) -> LeaseEpoch {
        self.lease_epoch
    }

    #[must_use]
    pub const fn writer_id(&self) -> &WriterId {
        &self.writer_id
    }
}
