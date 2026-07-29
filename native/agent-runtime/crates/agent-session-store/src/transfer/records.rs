use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use crate::hash::{ContentHash, encode_hex, sha256};
use crate::layout::validate_regular_file;
use crate::{LegacyStorageTransferRequest, SessionStoreError};

use super::files::sync_directory;

const REQUEST_DOMAIN: &[u8] = b"codestudio.agent.storage-transfer-request.v1\0";

pub fn request_fingerprint(request: &LegacyStorageTransferRequest) -> ContentHash {
    let mut input = Vec::with_capacity(256 + request.idempotency_key.len());
    input.extend_from_slice(REQUEST_DOMAIN);
    push_field(&mut input, request.session_id.as_str().as_bytes());
    input.extend_from_slice(&request.expected_source_lease_epoch.to_be_bytes());
    input.extend_from_slice(&request.next_authority.lease_epoch().get().to_be_bytes());
    push_field(
        &mut input,
        request.next_authority.writer_id().as_str().as_bytes(),
    );
    input.extend_from_slice(&request.verified_manifest_sha256);
    push_field(&mut input, request.idempotency_key.as_bytes());
    sha256(&input)
}

pub fn transaction_bytes(fingerprint: &ContentHash) -> Vec<u8> {
    format!("version=1\nrequest_sha256={}\n", encode_hex(fingerprint)).into_bytes()
}

pub fn receipt_bytes(request: &LegacyStorageTransferRequest, fingerprint: &ContentHash) -> Vec<u8> {
    format!(
        concat!(
            "version=1\nsession_id={}\nsource_generation=typescript_fs_v1\n",
            "source_lease_epoch={}\ntarget_generation=rust_fs_v1\n",
            "target_lease_epoch={}\nwriter_id={}\n",
            "verified_manifest_sha256={}\nrequest_sha256={}\n"
        ),
        request.session_id.as_str(),
        request.expected_source_lease_epoch,
        request.next_authority.lease_epoch().get(),
        request.next_authority.writer_id().as_str(),
        encode_hex(&request.verified_manifest_sha256),
        encode_hex(fingerprint)
    )
    .into_bytes()
}

pub fn guard_bytes(request: &LegacyStorageTransferRequest, fingerprint: &ContentHash) -> Vec<u8> {
    let token = encode_hex(fingerprint);
    format!(
        concat!(
            "{{\"schema_version\":1,\"token\":\"{}\",\"fence\":{},\"pid\":0,",
            "\"owner_id\":\"rust-storage-transfer:{}\",",
            "\"owner_host\":\"rust-storage-transfer\",",
            "\"acquired_at\":\"1970-01-01T00:00:00.000Z\",",
            "\"expires_at\":\"9999-12-31T23:59:59.999Z\"}}\n"
        ),
        token,
        request.next_authority.lease_epoch().get(),
        token
    )
    .into_bytes()
}

pub fn ensure_transaction(path: &Path, expected: &[u8]) -> Result<(), SessionStoreError> {
    ensure_exact_file(path, expected, SessionStoreError::DivergentReplay)
}

pub fn ensure_guard(path: &Path, expected: &[u8]) -> Result<(), SessionStoreError> {
    let parent = path.parent().ok_or(SessionStoreError::UnsafePath)?;
    super::files::create_directory(parent)?;
    ensure_exact_file(path, expected, SessionStoreError::WriterAlreadyActive)
}

pub fn remove_transaction(path: &Path) -> Result<(), SessionStoreError> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            validate_regular_file(path)?;
            fs::remove_file(path).map_err(|error| {
                SessionStoreError::io("remove storage transfer transaction", error)
            })?;
            sync_directory(path.parent().ok_or(SessionStoreError::UnsafePath)?)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(SessionStoreError::io(
            "inspect storage transfer transaction",
            error,
        )),
    }
}

pub fn remove_exact_guard(path: &Path, expected: &[u8]) -> Result<(), SessionStoreError> {
    validate_regular_file(path)?;
    let actual = fs::read(path)
        .map_err(|error| SessionStoreError::io("read storage transfer guard", error))?;
    if actual != expected {
        return Err(SessionStoreError::WriterAlreadyActive);
    }
    fs::remove_file(path)
        .map_err(|error| SessionStoreError::io("remove storage transfer guard", error))?;
    sync_directory(path.parent().ok_or(SessionStoreError::UnsafePath)?)
}

fn ensure_exact_file(
    path: &Path,
    expected: &[u8],
    divergent: SessionStoreError,
) -> Result<(), SessionStoreError> {
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => {
            file.write_all(expected)
                .map_err(|error| SessionStoreError::io("write storage transfer record", error))?;
            file.sync_all()
                .map_err(|error| SessionStoreError::io("sync storage transfer record", error))?;
            sync_directory(path.parent().ok_or(SessionStoreError::UnsafePath)?)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            validate_regular_file(path)?;
            let actual = fs::read(path)
                .map_err(|source| SessionStoreError::io("read storage transfer record", source))?;
            if actual == expected {
                Ok(())
            } else {
                Err(divergent)
            }
        }
        Err(error) => Err(SessionStoreError::io(
            "create storage transfer record",
            error,
        )),
    }
}

fn push_field(output: &mut Vec<u8>, field: &[u8]) {
    output.extend_from_slice(
        &u32::try_from(field.len())
            .expect("bounded transfer field fits u32")
            .to_be_bytes(),
    );
    output.extend_from_slice(field);
}
