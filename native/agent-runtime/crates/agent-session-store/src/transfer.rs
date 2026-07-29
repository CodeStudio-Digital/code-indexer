use std::path::Path;

use crate::hash::{ContentHash, sha256};
use crate::layout::validate_directory;
use crate::{SessionId, SessionStoreError, StorageGeneration};

mod files;
mod inventory;
mod records;
mod stage;
mod types;

use files::{TransferPaths, acquire_operation_lock, durable_rename, remove_tree};
use inventory::inspect_legacy_bundle;
use records::{guard_bytes, receipt_bytes, request_fingerprint, transaction_bytes};
use stage::{build_stage, verify_activated_bundle};
pub use types::{
    LegacyStorageTransferReceipt, LegacyStorageTransferRequest, LegacyTransferLimits,
    StorageTransferFaultInjector, StorageTransferFaultPoint,
};

#[derive(Debug)]
struct NoFaults;

impl StorageTransferFaultInjector for NoFaults {
    fn inject(&mut self, _point: StorageTransferFaultPoint) -> Result<(), SessionStoreError> {
        Ok(())
    }
}

/// Transfers one drained TypeScript filesystem bundle to the Rust generation.
///
/// # Errors
///
/// Fails closed on an active writer, stale epoch, divergent replay, unsafe
/// storage, incomplete verification, quota excess, or an I/O failure.
pub fn transfer_typescript_bundle(
    root: &Path,
    request: &LegacyStorageTransferRequest,
    limits: LegacyTransferLimits,
) -> Result<LegacyStorageTransferReceipt, SessionStoreError> {
    transfer_typescript_bundle_with_faults(root, request, limits, &mut NoFaults)
}

#[doc(hidden)]
pub fn transfer_typescript_bundle_with_faults(
    root: &Path,
    request: &LegacyStorageTransferRequest,
    limits: LegacyTransferLimits,
    faults: &mut dyn StorageTransferFaultInjector,
) -> Result<LegacyStorageTransferReceipt, SessionStoreError> {
    validate_request(root, request)?;
    let paths = TransferPaths::new(root, &request.session_id);
    let _operation_lock = acquire_operation_lock(&paths.lock)?;
    let fingerprint = request_fingerprint(request);
    let expected_receipt = receipt_bytes(request, &fingerprint);

    if paths.target.is_dir() && paths.receipt.is_file() {
        return replay_activated(&paths, request, limits, &expected_receipt);
    }

    records::ensure_transaction(&paths.transaction, &transaction_bytes(&fingerprint))?;
    let legacy = select_legacy_source(&paths)?;
    records::ensure_guard(
        &legacy.join("events").join("writer.lease"),
        &guard_bytes(request, &fingerprint),
    )?;
    faults.inject(StorageTransferFaultPoint::GuardDurable)?;

    let source_inventory = match inspect_legacy_bundle(
        &legacy,
        &request.session_id,
        request.expected_source_lease_epoch,
        limits,
    ) {
        Ok(inventory) => inventory,
        Err(error) if legacy == paths.target && deterministic_pre_cutover(&error) => {
            records::remove_exact_guard(
                &legacy.join("events").join("writer.lease"),
                &guard_bytes(request, &fingerprint),
            )?;
            records::remove_transaction(&paths.transaction)?;
            return Err(error);
        }
        Err(error) => return Err(error),
    };
    if source_inventory.hash != request.verified_manifest_sha256 {
        if legacy == paths.target {
            records::remove_exact_guard(
                &legacy.join("events").join("writer.lease"),
                &guard_bytes(request, &fingerprint),
            )?;
            records::remove_transaction(&paths.transaction)?;
        }
        return Err(SessionStoreError::TransferManifestMismatch);
    }
    build_stage(
        &paths,
        &legacy,
        request,
        limits,
        &source_inventory,
        &expected_receipt,
    )?;
    faults.inject(StorageTransferFaultPoint::StageVerified)?;

    if paths.target == legacy {
        durable_rename(&paths.target, &paths.backup, root)?;
        faults.inject(StorageTransferFaultPoint::SourceMoved)?;
    }
    durable_rename(&paths.staged_bundle(), &paths.target, root)?;
    faults.inject(StorageTransferFaultPoint::Activated)?;

    let receipt = verify_activated_bundle(&paths, request, limits, &expected_receipt, false)?;
    remove_tree(&paths.backup)?;
    files::remove_empty_stage(&paths.stage_root)?;
    records::remove_transaction(&paths.transaction)?;
    Ok(receipt)
}

fn validate_request(
    root: &Path,
    request: &LegacyStorageTransferRequest,
) -> Result<(), SessionStoreError> {
    if !root.is_absolute() {
        return Err(SessionStoreError::InvalidRoot);
    }
    validate_directory(root)?;
    let next_epoch = request
        .expected_source_lease_epoch
        .checked_add(1)
        .ok_or(SessionStoreError::InvalidTransfer)?;
    if request.expected_source_lease_epoch == 0
        || request.next_authority.generation() != StorageGeneration::RustFsV1
        || request.next_authority.lease_epoch().get() != next_epoch
        || request.idempotency_key.is_empty()
        || request.idempotency_key.len() > 512
        || request.idempotency_key.bytes().any(|byte| byte == 0)
    {
        return Err(SessionStoreError::InvalidTransfer);
    }
    Ok(())
}

fn select_legacy_source(paths: &TransferPaths) -> Result<std::path::PathBuf, SessionStoreError> {
    match (paths.target.is_dir(), paths.backup.is_dir()) {
        (true, false) => Ok(paths.target.clone()),
        (false, true) => Ok(paths.backup.clone()),
        _ => Err(SessionStoreError::CorruptLegacyBundle),
    }
}

fn replay_activated(
    paths: &TransferPaths,
    request: &LegacyStorageTransferRequest,
    limits: LegacyTransferLimits,
    expected_receipt: &[u8],
) -> Result<LegacyStorageTransferReceipt, SessionStoreError> {
    let receipt = verify_activated_bundle(paths, request, limits, expected_receipt, true)?;
    remove_tree(&paths.backup)?;
    files::remove_empty_stage(&paths.stage_root)?;
    records::remove_transaction(&paths.transaction)?;
    Ok(receipt)
}

fn make_receipt(
    request: &LegacyStorageTransferRequest,
    receipt_bytes: &[u8],
    replay: bool,
) -> LegacyStorageTransferReceipt {
    LegacyStorageTransferReceipt {
        session_id: request.session_id.clone(),
        source_generation: StorageGeneration::TypescriptFsV1,
        activated_authority: request.next_authority.clone(),
        verified_manifest_sha256: request.verified_manifest_sha256,
        activation_receipt_sha256: sha256(receipt_bytes),
        replay,
    }
}

/// Computes the bounded byte-manifest expected by a transfer request.
///
/// The caller must already have drained the TypeScript writer. The transfer
/// acquires its own physical guard and recomputes this manifest before cutover.
///
/// # Errors
///
/// Rejects stale epochs, unsafe paths, corrupt mandatory files, and limits.
pub fn verify_typescript_bundle_manifest(
    root: &Path,
    session_id: &SessionId,
    expected_source_lease_epoch: u64,
    limits: LegacyTransferLimits,
) -> Result<ContentHash, SessionStoreError> {
    if !root.is_absolute() {
        return Err(SessionStoreError::InvalidRoot);
    }
    validate_directory(root)?;
    let bundle = root.join(session_id.as_str());
    Ok(inspect_legacy_bundle(&bundle, session_id, expected_source_lease_epoch, limits)?.hash)
}

const fn deterministic_pre_cutover(error: &SessionStoreError) -> bool {
    matches!(
        error,
        SessionStoreError::StaleAuthority
            | SessionStoreError::CorruptLegacyBundle
            | SessionStoreError::TransferLimitExceeded
            | SessionStoreError::UnsafePath
    )
}
