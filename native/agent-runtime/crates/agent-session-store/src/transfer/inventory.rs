use std::fs::{self, File};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::hash::{ContentHash, encode_hex, sha256_reader};
use crate::layout::unsafe_metadata;
use crate::{LegacyTransferLimits, SessionId, SessionStoreError};

mod json;

const INVENTORY_DOMAIN: &[u8] = b"codestudio.agent.typescript-fs-v1.inventory.v1\0";
const EXCLUDED_GUARD: &str = "events/writer.lease";
const REQUIRED_FILES: &[&str] = &[
    "session.json",
    "state.json",
    "conversation.jsonl",
    "migration.json",
    "metrics/summary.json",
    "events/writer.fence.json",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyInventoryEntry {
    pub relative_path: String,
    pub bytes: u64,
    pub sha256: ContentHash,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyInventory {
    pub entries: Vec<LegacyInventoryEntry>,
    pub directories: Vec<String>,
    pub total_bytes: u64,
    pub hash: ContentHash,
}

impl LegacyInventory {
    pub fn manifest_bytes(&self) -> Vec<u8> {
        let mut output = format!(
            "version=1\naggregate_sha256={}\nfiles={}\nbytes={}\n",
            encode_hex(&self.hash),
            self.entries.len(),
            self.total_bytes
        )
        .into_bytes();
        for entry in &self.entries {
            output.extend_from_slice(
                format!(
                    "{}\t{}\t{}\n",
                    encode_hex(&entry.sha256),
                    entry.bytes,
                    encode_path(&entry.relative_path)
                )
                .as_bytes(),
            );
        }
        output
    }
}

pub fn inspect_legacy_bundle(
    root: &Path,
    session_id: &SessionId,
    expected_source_lease_epoch: u64,
    limits: LegacyTransferLimits,
) -> Result<LegacyInventory, SessionStoreError> {
    validate_legacy_root(root)?;
    validate_legacy_identity(root, session_id, expected_source_lease_epoch, limits)?;
    let mut inventory = LegacyInventory {
        entries: Vec::new(),
        directories: Vec::new(),
        total_bytes: 0,
        hash: [0; 32],
    };
    visit(root, root, limits, &mut inventory)?;
    inventory
        .entries
        .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    inventory.directories.sort();
    for required in REQUIRED_FILES {
        if !inventory
            .entries
            .iter()
            .any(|entry| entry.relative_path == *required)
        {
            return Err(SessionStoreError::CorruptLegacyBundle);
        }
    }
    inventory.hash = aggregate_hash(&inventory.entries)?;
    Ok(inventory)
}

fn visit(
    root: &Path,
    directory: &Path,
    limits: LegacyTransferLimits,
    inventory: &mut LegacyInventory,
) -> Result<(), SessionStoreError> {
    let mut children = fs::read_dir(directory)
        .map_err(|error| SessionStoreError::io("read legacy bundle directory", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| SessionStoreError::io("read legacy bundle entry", error))?;
    children.sort_by_key(std::fs::DirEntry::file_name);
    for entry in children {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| SessionStoreError::io("inspect legacy bundle entry", error))?;
        if unsafe_metadata(&metadata) {
            return Err(SessionStoreError::UnsafePath);
        }
        let relative = relative_name(root, &path)?;
        if relative == EXCLUDED_GUARD {
            continue;
        }
        if metadata.is_dir() {
            inventory.directories.push(relative);
            visit(root, &path, limits, inventory)?;
        } else if metadata.is_file() {
            add_file(path, relative, metadata.len(), limits, inventory)?;
        } else {
            return Err(SessionStoreError::UnsafePath);
        }
    }
    Ok(())
}

fn add_file(
    path: PathBuf,
    relative_path: String,
    bytes: u64,
    limits: LegacyTransferLimits,
    inventory: &mut LegacyInventory,
) -> Result<(), SessionStoreError> {
    if bytes > limits.max_file_bytes
        || u64::try_from(inventory.entries.len())
            .ok()
            .and_then(|count| count.checked_add(1))
            .is_none_or(|count| count > limits.max_files)
    {
        return Err(SessionStoreError::TransferLimitExceeded);
    }
    inventory.total_bytes = inventory
        .total_bytes
        .checked_add(bytes)
        .filter(|total| *total <= limits.max_total_bytes)
        .ok_or(SessionStoreError::TransferLimitExceeded)?;
    let mut file = File::open(path)
        .map_err(|error| SessionStoreError::io("open legacy bundle file", error))?;
    let hash = sha256_reader(&mut file, bytes)
        .map_err(|error| SessionStoreError::io("hash legacy bundle file", error))?;
    inventory.entries.push(LegacyInventoryEntry {
        relative_path,
        bytes,
        sha256: hash,
    });
    Ok(())
}

fn aggregate_hash(entries: &[LegacyInventoryEntry]) -> Result<ContentHash, SessionStoreError> {
    let mut hasher = Sha256::new();
    hasher.update(INVENTORY_DOMAIN);
    for entry in entries {
        let path = entry.relative_path.as_bytes();
        let length =
            u32::try_from(path.len()).map_err(|_| SessionStoreError::TransferLimitExceeded)?;
        hasher.update(length.to_be_bytes());
        hasher.update(path);
        hasher.update(entry.bytes.to_be_bytes());
        hasher.update(entry.sha256);
    }
    Ok(hasher.finalize().into())
}

fn validate_legacy_root(root: &Path) -> Result<(), SessionStoreError> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|error| SessionStoreError::io("inspect legacy bundle", error))?;
    if unsafe_metadata(&metadata) || !metadata.is_dir() {
        return Err(SessionStoreError::UnsafePath);
    }
    Ok(())
}

fn validate_legacy_identity(
    root: &Path,
    session_id: &SessionId,
    expected_source_lease_epoch: u64,
    limits: LegacyTransferLimits,
) -> Result<(), SessionStoreError> {
    let session = read_bounded(&root.join("session.json"), limits.max_file_bytes)?;
    let stored_id =
        json::string_field(&session, "id").ok_or(SessionStoreError::CorruptLegacyBundle)?;
    if stored_id != session_id.as_str() || json::u64_field(&session, "schema_version") != Some(1) {
        return Err(SessionStoreError::CorruptLegacyBundle);
    }
    let fence = read_bounded(
        &root.join("events").join("writer.fence.json"),
        limits.max_file_bytes,
    )?;
    if json::u64_field(&fence, "fence") != Some(expected_source_lease_epoch) {
        return Err(SessionStoreError::StaleAuthority);
    }
    Ok(())
}

fn read_bounded(path: &Path, max_bytes: u64) -> Result<Vec<u8>, SessionStoreError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| SessionStoreError::io("inspect legacy control file", error))?;
    if unsafe_metadata(&metadata) || !metadata.is_file() || metadata.len() > max_bytes {
        return Err(SessionStoreError::CorruptLegacyBundle);
    }
    fs::read(path).map_err(|error| SessionStoreError::io("read legacy control file", error))
}

fn relative_name(root: &Path, path: &Path) -> Result<String, SessionStoreError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| SessionStoreError::UnsafePath)?;
    let value = relative
        .to_str()
        .ok_or(SessionStoreError::UnsafePath)?
        .replace('\\', "/");
    if value.is_empty() || value.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(SessionStoreError::UnsafePath);
    }
    Ok(value)
}

fn encode_path(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .fold(String::with_capacity(value.len() * 2), |mut out, byte| {
            use std::fmt::Write as _;
            write!(out, "{byte:02x}").expect("write to string");
            out
        })
}
