use std::fmt::{self, Debug, Formatter};
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::Write;
use std::path::PathBuf;

use crate::{SessionStoreError, StorageAuthority};

pub struct WriterLease {
    path: PathBuf,
    owner: String,
    _file: File,
}

impl WriterLease {
    pub(crate) fn acquire(
        path: PathBuf,
        authority: &StorageAuthority,
    ) -> Result<Self, SessionStoreError> {
        // OS ownership is released even after process termination. The lock
        // inode is permanent: unlinking it would let two writers lock different
        // files under the same pathname. The separately readable owner record
        // continues to fence every journal operation.
        let lock_path = path.with_extension("lock");
        if lock_path.exists() {
            crate::layout::validate_regular_file(&lock_path)?;
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(|error| SessionStoreError::io("open session writer lock", error))?;
        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => return Err(SessionStoreError::WriterAlreadyActive),
            Err(TryLockError::Error(error)) => {
                return Err(SessionStoreError::io("lock session writer", error));
            }
        }
        // An older writer does not hold the new OS lock. Never steal its lease
        // based on age or a PID guess; it requires explicit legacy recovery.
        if path.exists() {
            crate::layout::validate_regular_file(&path)?;
            let previous = fs::read_to_string(&path)
                .map_err(|error| SessionStoreError::io("read previous writer lease", error))?;
            if !previous.starts_with("os-lock-v2 ") {
                return Err(SessionStoreError::WriterAlreadyActive);
            }
        }
        let pending_path = path.with_extension("lease.pending");
        if pending_path.exists() {
            crate::layout::validate_regular_file(&pending_path)?;
        }
        let mut owner_file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&pending_path)
            .map_err(|error| SessionStoreError::io("write session writer owner", error))?;
        let owner = owner_record(authority);
        write_and_sync(&mut owner_file, owner.as_bytes())?;
        drop(owner_file);
        fs::rename(pending_path, &path)
            .map_err(|error| SessionStoreError::io("publish writer owner", error))?;
        Ok(Self {
            path,
            owner,
            _file: file,
        })
    }

    pub(crate) fn verify(&self, authority: &StorageAuthority) -> Result<(), SessionStoreError> {
        let expected = owner_record(authority);
        let actual = fs::read_to_string(&self.path)
            .map_err(|error| SessionStoreError::io("read session writer lease", error))?;
        if actual != expected || self.owner != expected {
            return Err(SessionStoreError::StaleAuthority);
        }
        Ok(())
    }
}

impl Debug for WriterLease {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WriterLease")
            .field("path", &"[PRIVATE]")
            .field("owner", &"[REDACTED]")
            .finish()
    }
}

fn write_and_sync(file: &mut File, bytes: &[u8]) -> Result<(), SessionStoreError> {
    file.write_all(bytes)
        .map_err(|error| SessionStoreError::io("write session writer lease", error))?;
    file.sync_all()
        .map_err(|error| SessionStoreError::io("sync session writer lease", error))
}

fn owner_record(authority: &StorageAuthority) -> String {
    format!(
        "os-lock-v2 {} {} {}\n",
        authority.generation().name(),
        authority.lease_epoch().get(),
        authority.writer_id().as_str()
    )
}
