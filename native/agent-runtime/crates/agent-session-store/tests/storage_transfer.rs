use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use agent_session_store::{
    LeaseEpoch, LegacyStorageTransferRequest, LegacyTransferLimits, SessionId, SessionJournal,
    SessionStoreError, SessionStoreLimits, StorageAuthority, StorageTransferFaultInjector,
    StorageTransferFaultPoint, WriterId, transfer_typescript_bundle,
    transfer_typescript_bundle_with_faults, verify_typescript_bundle_manifest,
};

const SESSION: &str = "10000000-0000-0000-0000-000000000001";
static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
struct TestRoot(PathBuf);

impl TestRoot {
    fn new(label: &str) -> Self {
        let nonce = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "codestudio-storage-transfer-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("create transfer root");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn bundle(&self) -> PathBuf {
        self.0.join(SESSION)
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).expect("remove transfer root");
    }
}

#[test]
fn real_bundle_transfers_once_and_replays_from_durable_receipt() {
    let root = fixture("complete", 7);
    let request = request(&root, 7, "transfer:complete");
    let committed =
        transfer_typescript_bundle(root.path(), &request, limits()).expect("transfer bundle");
    assert!(!committed.replay);
    assert_eq!(
        fs::read(
            root.bundle()
                .join("legacy/typescript_fs_v1/attachments/blob.bin")
        )
        .expect("preserved attachment"),
        b"\0legacy-bytes\xff"
    );
    assert!(
        root.bundle()
            .join("legacy-typescript-fs-v1.manifest")
            .is_file()
    );
    assert!(
        !root
            .bundle()
            .join("legacy/typescript_fs_v1/events/writer.lease")
            .exists()
    );
    assert!(
        fs::read_to_string(root.bundle().join("session.json"))
            .expect("Rust manifest")
            .contains("\"storageGeneration\":\"rust_fs_v1\"")
    );

    let replay =
        transfer_typescript_bundle(root.path(), &request, limits()).expect("transfer replay");
    assert!(replay.replay);
    assert_eq!(
        replay.activation_receipt_sha256,
        committed.activation_receipt_sha256
    );

    let journal = SessionJournal::open(root.path(), session_id(), authority(8), journal_limits())
        .expect("open transferred Rust journal");
    assert_eq!(journal.committed_records(), 1);
}

#[test]
fn active_legacy_writer_and_stale_epoch_fail_closed() {
    let active = fixture("active", 3);
    fs::write(
        active.bundle().join("events/writer.lease"),
        b"{\"schema_version\":1,\"token\":\"other\"}\n",
    )
    .expect("active writer lease");
    let active_request = request(&active, 3, "transfer:active");
    assert!(matches!(
        transfer_typescript_bundle(active.path(), &active_request, limits()),
        Err(SessionStoreError::WriterAlreadyActive)
    ));
    assert!(active.bundle().join("session.json").is_file());

    let stale = fixture("stale", 4);
    let manifest =
        verify_typescript_bundle_manifest(stale.path(), &session_id(), 4, limits()).expect("hash");
    let stale_request = LegacyStorageTransferRequest {
        session_id: session_id(),
        expected_source_lease_epoch: 5,
        next_authority: authority(6),
        verified_manifest_sha256: manifest,
        idempotency_key: "transfer:stale".to_owned(),
    };
    assert!(matches!(
        transfer_typescript_bundle(stale.path(), &stale_request, limits()),
        Err(SessionStoreError::StaleAuthority)
    ));
    assert!(!stale.bundle().join("events/writer.lease").exists());
    assert!(stale.bundle().join("state.json").is_file());
}

#[test]
fn mutation_after_verification_is_rejected_without_stranding_the_legacy_writer() {
    let root = fixture("mutation", 2);
    let request = request(&root, 2, "transfer:mutation");
    fs::write(root.bundle().join("state.json"), b"{\"changed\":true}\n")
        .expect("mutate verified bundle");
    assert!(matches!(
        transfer_typescript_bundle(root.path(), &request, limits()),
        Err(SessionStoreError::TransferManifestMismatch)
    ));
    assert!(!root.bundle().join("events/writer.lease").exists());
    assert!(!root.bundle().join("storage-transfer-receipt.v1").exists());
}

#[test]
fn crash_at_every_transfer_barrier_recovers_idempotently() {
    for point in [
        StorageTransferFaultPoint::GuardDurable,
        StorageTransferFaultPoint::StageVerified,
        StorageTransferFaultPoint::SourceMoved,
        StorageTransferFaultPoint::Activated,
    ] {
        let root = fixture("crash", 9);
        let request = request(&root, 9, &format!("transfer:crash:{point:?}"));
        let mut crash = CrashOnce(Some(point));
        assert!(matches!(
            transfer_typescript_bundle_with_faults(root.path(), &request, limits(), &mut crash),
            Err(SessionStoreError::Io { .. })
        ));
        let recovered =
            transfer_typescript_bundle(root.path(), &request, limits()).expect("recover transfer");
        assert!(
            root.bundle()
                .join("legacy/typescript_fs_v1/conversation.jsonl")
                .is_file()
        );
        assert_eq!(
            recovered.verified_manifest_sha256,
            request.verified_manifest_sha256
        );
    }
}

#[test]
fn activated_generation_rejects_a_divergent_transfer_identity() {
    let root = fixture("divergent", 1);
    let request = request(&root, 1, "transfer:first");
    transfer_typescript_bundle(root.path(), &request, limits()).expect("activate Rust");
    let mut divergent = request;
    divergent.idempotency_key = "transfer:different".to_owned();
    assert!(matches!(
        transfer_typescript_bundle(root.path(), &divergent, limits()),
        Err(SessionStoreError::DivergentReplay)
    ));
}

#[derive(Debug)]
struct CrashOnce(Option<StorageTransferFaultPoint>);

impl StorageTransferFaultInjector for CrashOnce {
    fn inject(&mut self, point: StorageTransferFaultPoint) -> Result<(), SessionStoreError> {
        if self.0 == Some(point) {
            self.0 = None;
            return Err(SessionStoreError::Io {
                action: "injected transfer crash",
                source: io::Error::other("crash"),
            });
        }
        Ok(())
    }
}

fn fixture(label: &str, fence: u64) -> TestRoot {
    let root = TestRoot::new(label);
    let bundle = root.bundle();
    for directory in ["metrics", "events", "attachments", "tasks/nested"] {
        fs::create_dir_all(bundle.join(directory)).expect("create legacy directory");
    }
    fs::write(
        bundle.join("session.json"),
        format!(
            concat!(
                "{{\n  \"schema_version\": 1,\n  \"id\": \"{}\",\n",
                "  \"kind\": \"global\",\n  \"metadata\": {{\"id\": \"nested-value\"}}\n}}\n"
            ),
            SESSION
        ),
    )
    .expect("session metadata");
    fs::write(
        bundle.join("state.json"),
        b"{\"schema_version\":1,\"status\":\"idle\"}\n",
    )
    .expect("session state");
    fs::write(bundle.join("conversation.jsonl"), b"").expect("conversation");
    fs::write(
        bundle.join("migration.json"),
        b"{\"schema_version\":1,\"source\":\"native\"}\n",
    )
    .expect("migration marker");
    fs::write(
        bundle.join("metrics/summary.json"),
        b"{\"schema_version\":1,\"turns\":2}\n",
    )
    .expect("metrics");
    fs::write(
        bundle.join("events/writer.fence.json"),
        format!("{{\"schema_version\":1,\"fence\":{fence}}}\n"),
    )
    .expect("writer fence");
    fs::write(bundle.join("attachments/blob.bin"), b"\0legacy-bytes\xff")
        .expect("legacy attachment");
    fs::write(bundle.join("tasks/nested/task.json"), b"{\"task\":1}\n")
        .expect("nested legacy data");
    root
}

fn request(root: &TestRoot, epoch: u64, idempotency: &str) -> LegacyStorageTransferRequest {
    let manifest = verify_typescript_bundle_manifest(root.path(), &session_id(), epoch, limits())
        .expect("verify legacy manifest");
    LegacyStorageTransferRequest {
        session_id: session_id(),
        expected_source_lease_epoch: epoch,
        next_authority: authority(epoch + 1),
        verified_manifest_sha256: manifest,
        idempotency_key: idempotency.to_owned(),
    }
}

fn session_id() -> SessionId {
    SessionId::parse(SESSION).expect("session ID")
}

fn authority(epoch: u64) -> StorageAuthority {
    StorageAuthority::rust_fs_v1(
        LeaseEpoch::new(epoch).expect("epoch"),
        WriterId::parse("20000000-0000-0000-0000-000000000001").expect("writer ID"),
    )
}

fn journal_limits() -> SessionStoreLimits {
    SessionStoreLimits::new(16, 4096, 16).expect("journal limits")
}

fn limits() -> LegacyTransferLimits {
    LegacyTransferLimits::new(128, 64 * 1024, 512 * 1024, journal_limits())
        .expect("transfer limits")
}
