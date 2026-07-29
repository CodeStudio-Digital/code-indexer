use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

use crate::hash::{ContentHash, sha256, sha256_reader};
use crate::layout::{SessionBundleLayout, validate_regular_file};
use crate::{SessionRecordKind, SessionStoreError};

pub fn commit_payload(
    layout: &SessionBundleLayout,
    kind: SessionRecordKind,
    payload: &[u8],
    payload_hash: &ContentHash,
    payload_bytes: u64,
) -> Result<(), SessionStoreError> {
    let path = layout.payload(kind, payload_hash);
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            if let Err(error) = write_payload(&mut file, payload) {
                let _ = fs::remove_file(path);
                return Err(error);
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            verify_existing_payload(&path, payload_hash, payload_bytes)
        }
        Err(error) => Err(SessionStoreError::io("create session payload", error)),
    }
}

pub fn read_payload(
    layout: &SessionBundleLayout,
    kind: SessionRecordKind,
    payload_hash: &ContentHash,
    expected_bytes: u64,
    maximum_bytes: u64,
) -> Result<Vec<u8>, SessionStoreError> {
    if expected_bytes > maximum_bytes {
        return Err(SessionStoreError::PayloadLimitExceeded);
    }
    let length =
        usize::try_from(expected_bytes).map_err(|_| SessionStoreError::PayloadLimitExceeded)?;
    let path = layout.payload(kind, payload_hash);
    validate_regular_file(&path)?;
    let file =
        File::open(path).map_err(|error| SessionStoreError::io("open session payload", error))?;
    if file
        .metadata()
        .map_err(|error| SessionStoreError::io("inspect session payload", error))?
        .len()
        != expected_bytes
    {
        return Err(SessionStoreError::DivergentPayload);
    }
    let read_ceiling = expected_bytes
        .checked_add(1)
        .ok_or(SessionStoreError::PayloadLimitExceeded)?;
    let mut encoded = Vec::with_capacity(length);
    file.take(read_ceiling)
        .read_to_end(&mut encoded)
        .map_err(|error| SessionStoreError::io("read session payload", error))?;
    if encoded.len() != length || sha256(&encoded) != *payload_hash {
        return Err(SessionStoreError::DivergentPayload);
    }
    Ok(encoded)
}

fn write_payload(file: &mut File, payload: &[u8]) -> Result<(), SessionStoreError> {
    file.write_all(payload)
        .map_err(|error| SessionStoreError::io("write session payload", error))?;
    file.sync_all()
        .map_err(|error| SessionStoreError::io("sync session payload", error))
}

fn verify_existing_payload(
    path: &Path,
    payload_hash: &ContentHash,
    payload_bytes: u64,
) -> Result<(), SessionStoreError> {
    validate_regular_file(path)?;
    let mut file = File::open(path)
        .map_err(|error| SessionStoreError::io("open existing session payload", error))?;
    let actual = sha256_reader(&mut file, payload_bytes)
        .map_err(|error| SessionStoreError::io("hash existing session payload", error))?;
    if actual != *payload_hash {
        return Err(SessionStoreError::DivergentPayload);
    }
    Ok(())
}
