use std::fmt::{self, Debug, Formatter};
use std::fs::{self, File, OpenOptions};
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
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(SessionStoreError::WriterAlreadyActive);
            }
            Err(error) => return Err(SessionStoreError::io("acquire session writer", error)),
        };
        let owner = owner_record(authority);
        if let Err(error) = write_and_sync(&mut file, owner.as_bytes()) {
            let _ = fs::remove_file(&path);
            return Err(error);
        }
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

impl Drop for WriterLease {
    fn drop(&mut self) {
        let matches_owner = fs::read_to_string(&self.path).is_ok_and(|value| value == self.owner);
        if matches_owner {
            let _ = fs::remove_file(&self.path);
        }
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
        "{} {} {}\n",
        authority.generation().name(),
        authority.lease_epoch().get(),
        authority.writer_id().as_str()
    )
}
