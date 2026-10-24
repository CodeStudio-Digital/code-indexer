use std::fs::{File, OpenOptions, TryLockError};
use std::path::Path;

use crate::SessionStoreError;

/// A process-owned mutex in an authenticated storage root. The file is
/// permanent so contenders cannot acquire different inodes under one name.
#[derive(Debug)]
pub struct StorageRootLock {
    _file: File,
}

impl StorageRootLock {
    /// # Errors
    /// Rejects unsafe roots, a busy lock or filesystem failures.
    pub fn acquire(root: &Path, name: &str) -> Result<Self, SessionStoreError> {
        if !root.is_absolute()
            || name.is_empty()
            || name.len() > 64
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(SessionStoreError::InvalidRoot);
        }
        crate::layout::validate_directory(root)?;
        let path = root.join(format!(".storage-{name}.lock"));
        if path.exists() {
            crate::layout::validate_regular_file(&path)?;
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(|error| SessionStoreError::io("open storage root lock", error))?;
        match file.try_lock() {
            Ok(()) => Ok(Self { _file: file }),
            Err(TryLockError::WouldBlock) => Err(SessionStoreError::StorageLockBusy),
            Err(TryLockError::Error(error)) => {
                Err(SessionStoreError::io("lock storage root", error))
            }
        }
    }
}
