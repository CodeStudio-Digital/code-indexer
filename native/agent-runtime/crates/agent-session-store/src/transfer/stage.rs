use std::fs;
use std::path::Path;

use crate::hash::{ContentHash, encode_hex};
use crate::layout::validate_regular_file;
use crate::{
    AppendRequest, DurabilityClass, LegacyStorageTransferReceipt, LegacyStorageTransferRequest,
    LegacyTransferLimits, OperationId, SessionJournal, SessionRecordKind, SessionStoreError,
};

use super::files::{
    TransferPaths, copy_verified_file, create_directory, remove_tree, sync_directory,
    write_new_file,
};
use super::inventory::{LegacyInventory, inspect_legacy_bundle};
use super::{make_receipt, records};

pub fn build_stage(
    paths: &TransferPaths,
    legacy_source: &Path,
    request: &LegacyStorageTransferRequest,
    limits: LegacyTransferLimits,
    source_inventory: &LegacyInventory,
    receipt: &[u8],
) -> Result<(), SessionStoreError> {
    remove_tree(&paths.stage_root)?;
    create_directory(&paths.stage_root)?;
    let staged_bundle = paths.staged_bundle();
    {
        let mut journal = SessionJournal::open_transferred(
            &paths.stage_root,
            request.session_id.clone(),
            request.next_authority.clone(),
            limits.journal,
        )?;
        let operation_id = migration_operation_id(&records::request_fingerprint(request))?;
        let payload = migration_payload(request);
        journal.append(AppendRequest {
            operation_id: &operation_id,
            kind: SessionRecordKind::Checkpoint,
            durability: DurabilityClass::Authoritative,
            payload: &payload,
        })?;
    }

    let legacy_target = staged_bundle.join("legacy").join("typescript_fs_v1");
    create_directory(&staged_bundle.join("legacy"))?;
    create_directory(&legacy_target)?;
    copy_inventory(legacy_source, &legacy_target, source_inventory)?;
    write_new_file(
        &staged_bundle.join("legacy-typescript-fs-v1.manifest"),
        &source_inventory.manifest_bytes(),
    )?;
    write_new_file(&staged_bundle.join("storage-transfer-receipt.v1"), receipt)?;
    sync_directory(&staged_bundle)?;

    let copied = inspect_legacy_bundle(
        &legacy_target,
        &request.session_id,
        request.expected_source_lease_epoch,
        limits,
    )?;
    let source_after = inspect_legacy_bundle(
        legacy_source,
        &request.session_id,
        request.expected_source_lease_epoch,
        limits,
    )?;
    if copied != *source_inventory || source_after != *source_inventory {
        return Err(SessionStoreError::ConcurrentMutation);
    }
    Ok(())
}

pub fn verify_activated_bundle(
    paths: &TransferPaths,
    request: &LegacyStorageTransferRequest,
    limits: LegacyTransferLimits,
    expected_receipt: &[u8],
    replay: bool,
) -> Result<LegacyStorageTransferReceipt, SessionStoreError> {
    validate_regular_file(&paths.receipt)?;
    let actual = fs::read(&paths.receipt)
        .map_err(|error| SessionStoreError::io("read activation receipt", error))?;
    if actual != expected_receipt {
        return Err(SessionStoreError::DivergentReplay);
    }
    let legacy = paths.target.join("legacy").join("typescript_fs_v1");
    let inventory = inspect_legacy_bundle(
        &legacy,
        &request.session_id,
        request.expected_source_lease_epoch,
        limits,
    )?;
    if inventory.hash != request.verified_manifest_sha256 {
        return Err(SessionStoreError::TransferManifestMismatch);
    }
    drop(SessionJournal::open(
        paths
            .target
            .parent()
            .ok_or(SessionStoreError::InvalidRoot)?,
        request.session_id.clone(),
        request.next_authority.clone(),
        limits.journal,
    )?);
    Ok(make_receipt(request, expected_receipt, replay))
}

fn copy_inventory(
    source: &Path,
    target: &Path,
    inventory: &LegacyInventory,
) -> Result<(), SessionStoreError> {
    for relative in &inventory.directories {
        create_directory(&target.join(path_from_relative(relative)))?;
    }
    for entry in &inventory.entries {
        let relative = path_from_relative(&entry.relative_path);
        copy_verified_file(
            &source.join(&relative),
            &target.join(&relative),
            entry.bytes,
            &entry.sha256,
        )?;
    }
    Ok(())
}

fn migration_operation_id(hash: &ContentHash) -> Result<OperationId, SessionStoreError> {
    let value = encode_hex(hash);
    OperationId::parse(format!(
        "{}-{}-{}-{}-{}",
        &value[0..8],
        &value[8..12],
        &value[12..16],
        &value[16..20],
        &value[20..32]
    ))
}

fn migration_payload(request: &LegacyStorageTransferRequest) -> Vec<u8> {
    format!(
        concat!(
            "{{\"legacyBundle\":\"legacy/typescript_fs_v1\",",
            "\"sourceGeneration\":\"typescript_fs_v1\",",
            "\"verifiedManifestSha256\":\"{}\"}}"
        ),
        encode_hex(&request.verified_manifest_sha256)
    )
    .into_bytes()
}

fn path_from_relative(relative: &str) -> std::path::PathBuf {
    relative.split('/').collect()
}
