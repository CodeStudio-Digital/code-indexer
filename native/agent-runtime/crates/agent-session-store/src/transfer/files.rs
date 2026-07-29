use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::hash::{ContentHash, sha256_reader};
use crate::layout::{unsafe_metadata, validate_directory, validate_regular_file};
use crate::{SessionId, SessionStoreError};

#[derive(Debug)]
pub struct TransferPaths {
    pub target: PathBuf,
    pub backup: PathBuf,
    pub stage_root: PathBuf,
    pub transaction: PathBuf,
    pub lock: PathBuf,
    pub receipt: PathBuf,
}

impl TransferPaths {
    pub fn new(root: &Path, session_id: &SessionId) -> Self {
        let prefix = format!(".rust-transfer-{}", session_id.as_str());
        let target = root.join(session_id.as_str());
        Self {
            receipt: target.join("storage-transfer-receipt.v1"),
            target,
            backup: root.join(format!("{prefix}.source")),
            stage_root: root.join(format!("{prefix}.stage")),
            transaction: root.join(format!("{prefix}.txn")),
            lock: root.join(format!("{prefix}.lock")),
        }
    }

    pub fn staged_bundle(&self) -> PathBuf {
        self.stage_root.join(
            self.target
                .file_name()
                .expect("session target always has a file name"),
        )
    }
}

#[derive(Debug)]
pub struct OperationLock(File);

impl Drop for OperationLock {
    fn drop(&mut self) {
        let _ = File::unlock(&self.0);
    }
}

pub fn acquire_operation_lock(path: &Path) -> Result<OperationLock, SessionStoreError> {
    let file = match OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(file) => {
            file.sync_all()
                .map_err(|error| SessionStoreError::io("sync storage transfer lock", error))?;
            sync_directory(path.parent().ok_or(SessionStoreError::UnsafePath)?)?;
            file
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            validate_regular_file(path)?;
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(path)
                .map_err(|source| SessionStoreError::io("open storage transfer lock", source))?
        }
        Err(error) => {
            return Err(SessionStoreError::io("create storage transfer lock", error));
        }
    };
    file.try_lock()
        .map_err(|_| SessionStoreError::WriterAlreadyActive)?;
    Ok(OperationLock(file))
}

pub fn create_directory(path: &Path) -> Result<(), SessionStoreError> {
    match fs::create_dir(path) {
        Ok(()) => {
            sync_directory(path.parent().ok_or(SessionStoreError::UnsafePath)?)?;
            validate_directory(path)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => validate_directory(path),
        Err(error) => Err(SessionStoreError::io(
            "create storage transfer directory",
            error,
        )),
    }
}

pub fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), SessionStoreError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| SessionStoreError::io("create storage transfer file", error))?;
    file.write_all(bytes)
        .map_err(|error| SessionStoreError::io("write storage transfer file", error))?;
    file.sync_all()
        .map_err(|error| SessionStoreError::io("sync storage transfer file", error))?;
    sync_directory(path.parent().ok_or(SessionStoreError::UnsafePath)?)
}

pub fn copy_verified_file(
    source: &Path,
    target: &Path,
    expected_bytes: u64,
    expected_hash: &ContentHash,
) -> Result<(), SessionStoreError> {
    validate_regular_file(source)?;
    let mut input = File::open(source)
        .map_err(|error| SessionStoreError::io("open legacy transfer source", error))?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|error| SessionStoreError::io("create legacy transfer copy", error))?;
    let copied = std::io::copy(&mut input, &mut output)
        .map_err(|error| SessionStoreError::io("copy legacy transfer file", error))?;
    if copied != expected_bytes {
        return Err(SessionStoreError::ConcurrentMutation);
    }
    output
        .sync_all()
        .map_err(|error| SessionStoreError::io("sync legacy transfer copy", error))?;
    let mut copied_file = File::open(target)
        .map_err(|error| SessionStoreError::io("reopen legacy transfer copy", error))?;
    let actual = sha256_reader(&mut copied_file, expected_bytes)
        .map_err(|error| SessionStoreError::io("verify legacy transfer copy", error))?;
    if &actual != expected_hash {
        return Err(SessionStoreError::ConcurrentMutation);
    }
    Ok(())
}

pub fn durable_rename(source: &Path, target: &Path, root: &Path) -> Result<(), SessionStoreError> {
    if target.exists() {
        return Err(SessionStoreError::ConcurrentMutation);
    }
    fs::rename(source, target)
        .map_err(|error| SessionStoreError::io("rename storage generation", error))?;
    sync_directory(root)
}

pub fn remove_empty_stage(path: &Path) -> Result<(), SessionStoreError> {
    match fs::remove_dir(path) {
        Ok(()) => sync_directory(path.parent().ok_or(SessionStoreError::UnsafePath)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => Ok(()),
        Err(error) => Err(SessionStoreError::io(
            "remove empty storage transfer stage",
            error,
        )),
    }
}

pub fn remove_tree(path: &Path) -> Result<(), SessionStoreError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(SessionStoreError::io("inspect transfer cleanup", error)),
    };
    if unsafe_metadata(&metadata) || !metadata.is_dir() {
        return Err(SessionStoreError::UnsafePath);
    }
    remove_directory_contents(path)?;
    fs::remove_dir(path)
        .map_err(|error| SessionStoreError::io("remove transfer directory", error))?;
    sync_directory(path.parent().ok_or(SessionStoreError::UnsafePath)?)
}

fn remove_directory_contents(path: &Path) -> Result<(), SessionStoreError> {
    for entry in fs::read_dir(path)
        .map_err(|error| SessionStoreError::io("read transfer cleanup directory", error))?
    {
        let child = entry
            .map_err(|error| SessionStoreError::io("read transfer cleanup entry", error))?
            .path();
        let metadata = fs::symlink_metadata(&child)
            .map_err(|error| SessionStoreError::io("inspect transfer cleanup entry", error))?;
        if unsafe_metadata(&metadata) {
            return Err(SessionStoreError::UnsafePath);
        }
        if metadata.is_dir() {
            remove_directory_contents(&child)?;
            fs::remove_dir(&child)
                .map_err(|error| SessionStoreError::io("remove transfer subdirectory", error))?;
        } else if metadata.is_file() {
            fs::remove_file(&child)
                .map_err(|error| SessionStoreError::io("remove transfer file", error))?;
        } else {
            return Err(SessionStoreError::UnsafePath);
        }
    }
    Ok(())
}

pub fn sync_directory(path: &Path) -> Result<(), SessionStoreError> {
    match File::open(path).and_then(|file| file.sync_all()) {
        Ok(()) => Ok(()),
        #[cfg(windows)]
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::InvalidInput
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(SessionStoreError::io(
            "sync storage transfer directory",
            error,
        )),
    }
}
