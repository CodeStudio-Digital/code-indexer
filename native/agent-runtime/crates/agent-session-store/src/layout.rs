use std::fs;
use std::path::{Path, PathBuf};

use crate::hash::{ContentHash, encode_hex};
use crate::{SessionId, SessionRecordKind, SessionStoreError};

const BUNDLE_DIRECTORIES: &[&str] = &[
    "attachments",
    "tool-outputs",
    "snapshots",
    "metrics",
    "events",
    "checkpoints",
    "chapters",
    "plans",
    "tasks",
    "inputs",
    "memory",
    "subagents",
    "company",
    "sprite",
];

#[derive(Debug)]
pub struct SessionBundleLayout {
    bundle: PathBuf,
}

impl SessionBundleLayout {
    pub(crate) fn open_existing(
        root: &Path,
        session_id: &SessionId,
    ) -> Result<Self, SessionStoreError> {
        if !root.is_absolute() {
            return Err(SessionStoreError::InvalidRoot);
        }
        validate_directory(root)?;
        let bundle = root.join(session_id.as_str());
        validate_directory(&bundle)?;
        for directory in BUNDLE_DIRECTORIES {
            validate_directory(&bundle.join(directory))?;
        }
        Ok(Self { bundle })
    }

    pub(crate) fn create(root: &Path, session_id: &SessionId) -> Result<Self, SessionStoreError> {
        if !root.is_absolute() {
            return Err(SessionStoreError::InvalidRoot);
        }
        validate_directory(root)?;
        let bundle = root.join(session_id.as_str());
        create_or_validate_directory(&bundle)?;
        for directory in BUNDLE_DIRECTORIES {
            create_or_validate_directory(&bundle.join(directory))?;
        }
        Ok(Self { bundle })
    }

    pub(crate) fn journal(&self) -> PathBuf {
        self.bundle.join("conversation.jsonl")
    }

    pub(crate) fn manifest(&self) -> PathBuf {
        self.bundle.join("session.json")
    }

    pub(crate) fn authority_log(&self) -> PathBuf {
        self.bundle.join("storage-authority.jsonl")
    }

    pub(crate) fn lease(&self) -> PathBuf {
        self.bundle.join(".rust-writer.lease")
    }

    pub(crate) fn payload(&self, kind: SessionRecordKind, hash: &ContentHash) -> PathBuf {
        self.bundle
            .join(kind.directory())
            .join(format!("{}.blob", encode_hex(hash)))
    }
}

fn create_or_validate_directory(path: &Path) -> Result<(), SessionStoreError> {
    match fs::create_dir(path) {
        Ok(()) => validate_directory(path),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => validate_directory(path),
        Err(error) => Err(SessionStoreError::io("create session directory", error)),
    }
}

pub fn validate_regular_file(path: &Path) -> Result<(), SessionStoreError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| SessionStoreError::io("inspect session file", error))?;
    if unsafe_metadata(&metadata) || !metadata.is_file() {
        return Err(SessionStoreError::UnsafePath);
    }
    Ok(())
}

pub fn validate_directory(path: &Path) -> Result<(), SessionStoreError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| SessionStoreError::io("inspect session directory", error))?;
    if unsafe_metadata(&metadata) || !metadata.is_dir() {
        return Err(SessionStoreError::UnsafePath);
    }
    Ok(())
}

#[cfg(windows)]
pub fn unsafe_metadata(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
pub fn unsafe_metadata(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}
