use std::fmt::Write as _;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use agent_session_store::{
    AppendRequest, CommitOutcome, DurabilityClass, LeaseEpoch, OperationId,
    ReadCommittedPayloadRequest, SessionId, SessionJournal, SessionRecordKind, SessionStoreError,
    SessionStoreLimits, StorageAuthority, StorageGeneration, WriterId,
};

static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

struct TestRoot(PathBuf);

impl TestRoot {
    fn new(label: &str) -> Self {
        let nonce = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "codestudio-agent-session-store-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("create test root");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).expect("remove test root");
    }
}

fn session_id() -> SessionId {
    SessionId::parse("10000000-0000-0000-0000-000000000001").expect("session id")
}

fn writer_id(value: u8) -> WriterId {
    WriterId::parse(format!("20000000-0000-0000-0000-{value:012x}")).expect("writer id")
}

fn authority(epoch: u64, writer: u8) -> StorageAuthority {
    StorageAuthority::rust_fs_v1(
        LeaseEpoch::new(epoch).expect("lease epoch"),
        writer_id(writer),
    )
}

fn operation_id(value: u8) -> OperationId {
    OperationId::parse(format!("30000000-0000-0000-0000-{value:012x}")).expect("operation id")
}

fn limits(records: u64, payload_bytes: u64) -> SessionStoreLimits {
    SessionStoreLimits::new(records, payload_bytes, 8).expect("limits")
}

#[test]
fn commit_replay_recovery_and_hash_chain_are_stable() {
    let root = TestRoot::new("round-trip");
    let first_operation = operation_id(1);
    let second_operation = operation_id(2);
    let first_receipt;
    {
        let mut journal =
            SessionJournal::open(root.path(), session_id(), authority(1, 1), limits(8, 1024))
                .expect("open writer");
        let committed = journal
            .append(AppendRequest {
                operation_id: &first_operation,
                kind: SessionRecordKind::Conversation,
                durability: DurabilityClass::Durable,
                payload: br#"{"message":"hello"}"#,
            })
            .expect("commit");
        assert!(matches!(committed, CommitOutcome::Committed(_)));
        first_receipt = committed.receipt().clone();

        let replay = journal
            .append(AppendRequest {
                operation_id: &first_operation,
                kind: SessionRecordKind::Conversation,
                durability: DurabilityClass::Durable,
                payload: br#"{"message":"hello"}"#,
            })
            .expect("replay");
        assert!(matches!(replay, CommitOutcome::Replay(_)));
        assert_eq!(replay.receipt(), &first_receipt);
        assert_eq!(journal.committed_records(), 1);

        assert!(matches!(
            journal.append(AppendRequest {
                operation_id: &first_operation,
                kind: SessionRecordKind::Conversation,
                durability: DurabilityClass::Durable,
                payload: br#"{"message":"different"}"#,
            }),
            Err(SessionStoreError::DivergentReplay)
        ));

        let second = journal
            .append(AppendRequest {
                operation_id: &second_operation,
                kind: SessionRecordKind::MetricRollup,
                durability: DurabilityClass::Coalesced,
                payload: br#"{"rssBytes":42}"#,
            })
            .expect("metric commit");
        assert_eq!(second.receipt().sequence(), 2);
        assert_eq!(
            second.receipt().storage_generation(),
            StorageGeneration::RustFsV1
        );
        assert_eq!(second.receipt().lease_epoch().get(), 1);
        assert_eq!(second.receipt().writer_id(), &writer_id(1));
        assert_eq!(second.receipt().durability(), DurabilityClass::Coalesced);
        assert_eq!(second.receipt().kind(), SessionRecordKind::MetricRollup);
        assert_eq!(second.receipt().payload_bytes(), 15);
        assert_ne!(second.receipt().record_hash(), first_receipt.record_hash());
    }

    let mut reopened =
        SessionJournal::open(root.path(), session_id(), authority(2, 2), limits(8, 1024))
            .expect("recover writer");
    assert_eq!(reopened.committed_records(), 2);
    let replay = reopened
        .append(AppendRequest {
            operation_id: &first_operation,
            kind: SessionRecordKind::Conversation,
            durability: DurabilityClass::Durable,
            payload: br#"{"message":"hello"}"#,
        })
        .expect("replay after recovery");
    assert_eq!(replay.receipt(), &first_receipt);
}

#[test]
fn writer_lease_and_limits_fail_closed() {
    let root = TestRoot::new("limits");
    let mut writer = SessionJournal::open(root.path(), session_id(), authority(1, 1), limits(1, 4))
        .expect("first writer");
    assert!(matches!(
        SessionJournal::open(root.path(), session_id(), authority(2, 2), limits(1, 4)),
        Err(SessionStoreError::WriterAlreadyActive)
    ));
    assert!(matches!(
        writer.append(AppendRequest {
            operation_id: &operation_id(1),
            kind: SessionRecordKind::Input,
            durability: DurabilityClass::Authoritative,
            payload: b"12345",
        }),
        Err(SessionStoreError::PayloadLimitExceeded)
    ));
    writer
        .append(AppendRequest {
            operation_id: &operation_id(2),
            kind: SessionRecordKind::Input,
            durability: DurabilityClass::Authoritative,
            payload: b"1234",
        })
        .expect("bounded record");
    assert!(matches!(
        writer.append(AppendRequest {
            operation_id: &operation_id(3),
            kind: SessionRecordKind::Task,
            durability: DurabilityClass::Authoritative,
            payload: b"x",
        }),
        Err(SessionStoreError::RecordLimitExceeded)
    ));
}

#[test]
fn incomplete_tail_is_truncated_before_new_commits() {
    let root = TestRoot::new("tail");
    {
        let mut writer =
            SessionJournal::open(root.path(), session_id(), authority(1, 1), limits(8, 1024))
                .expect("open writer");
        writer
            .append(AppendRequest {
                operation_id: &operation_id(1),
                kind: SessionRecordKind::LifecycleEvent,
                durability: DurabilityClass::Authoritative,
                payload: b"prepared",
            })
            .expect("commit");
    }

    let journal_path = root
        .path()
        .join(session_id().as_str())
        .join("conversation.jsonl");
    let valid_length = fs::metadata(&journal_path).expect("journal metadata").len();
    let mut file = OpenOptions::new()
        .append(true)
        .open(&journal_path)
        .expect("open journal tail");
    file.write_all(b"{\"v\":1,\"seq\":2")
        .expect("append incomplete tail");
    file.sync_all().expect("sync incomplete tail");
    drop(file);

    let writer = SessionJournal::open(root.path(), session_id(), authority(2, 2), limits(8, 1024))
        .expect("recover tail");
    assert_eq!(writer.committed_records(), 1);
    assert_eq!(
        fs::metadata(journal_path)
            .expect("recovered journal metadata")
            .len(),
        valid_length
    );
}

#[test]
fn payload_tamper_blocks_recovery() {
    let root = TestRoot::new("tamper");
    {
        let mut writer =
            SessionJournal::open(root.path(), session_id(), authority(1, 1), limits(8, 1024))
                .expect("open writer");
        writer
            .append(AppendRequest {
                operation_id: &operation_id(1),
                kind: SessionRecordKind::Checkpoint,
                durability: DurabilityClass::Authoritative,
                payload: b"checkpoint",
            })
            .expect("commit");
    }
    let checkpoint_dir = root.path().join(session_id().as_str()).join("checkpoints");
    let payload = fs::read_dir(checkpoint_dir)
        .expect("checkpoint directory")
        .next()
        .expect("payload entry")
        .expect("payload path")
        .path();
    fs::write(payload, b"tampered!!").expect("tamper payload");

    assert!(matches!(
        SessionJournal::open(root.path(), session_id(), authority(2, 2), limits(8, 1024)),
        Err(SessionStoreError::DivergentPayload)
    ));
}

#[test]
fn committed_payload_reads_require_exact_fenced_receipt_and_bounds() {
    let root = TestRoot::new("committed-read");
    let operation = operation_id(1);
    let mut writer =
        SessionJournal::open(root.path(), session_id(), authority(1, 1), limits(8, 1024))
            .expect("open writer");
    let committed = writer
        .append(AppendRequest {
            operation_id: &operation,
            kind: SessionRecordKind::Input,
            durability: DurabilityClass::Authoritative,
            payload: b"verified-input",
        })
        .expect("commit input");
    let receipt = committed.receipt();
    let request = ReadCommittedPayloadRequest {
        operation_id: &operation,
        kind: SessionRecordKind::Input,
        expected_payload_sha256: receipt.payload_hash(),
        expected_payload_bytes: receipt.payload_bytes(),
        maximum_payload_bytes: 1024,
    };
    let loaded = writer
        .read_committed_payload(request)
        .expect("read exact committed payload");
    assert_eq!(loaded.receipt(), receipt);
    assert_eq!(loaded.encoded_payload(), b"verified-input");
    let debug = format!("{loaded:?}");
    assert!(debug.contains("[REDACTED]"));
    assert!(!debug.contains("verified-input"));

    assert!(matches!(
        writer.read_committed_payload(ReadCommittedPayloadRequest {
            maximum_payload_bytes: 1,
            ..request
        }),
        Err(SessionStoreError::PayloadLimitExceeded)
    ));
    assert!(matches!(
        writer.read_committed_payload(ReadCommittedPayloadRequest {
            operation_id: &operation_id(2),
            ..request
        }),
        Err(SessionStoreError::MissingPayload)
    ));
    assert!(matches!(
        writer.read_committed_payload(ReadCommittedPayloadRequest {
            expected_payload_sha256: [9; 32],
            ..request
        }),
        Err(SessionStoreError::DivergentReplay)
    ));

    let payload_hash =
        receipt
            .payload_hash()
            .iter()
            .fold(String::with_capacity(64), |mut output, byte| {
                write!(&mut output, "{byte:02x}").expect("write payload hash");
                output
            });
    let payload_path = root
        .path()
        .join(session_id().as_str())
        .join("inputs")
        .join(format!("{payload_hash}.blob"));
    fs::write(payload_path, b"tampered-input").expect("tamper payload");
    assert!(matches!(
        writer.read_committed_payload(request),
        Err(SessionStoreError::DivergentPayload)
    ));
}

#[test]
fn authority_epochs_are_contiguous_fenced_and_recoverable() {
    let root = TestRoot::new("authority");
    assert!(matches!(
        SessionJournal::open(root.path(), session_id(), authority(2, 2), limits(8, 1024)),
        Err(SessionStoreError::AuthorityGap)
    ));
    {
        SessionJournal::open(root.path(), session_id(), authority(1, 1), limits(8, 1024))
            .expect("activate first authority");
    }
    assert!(matches!(
        SessionJournal::open(root.path(), session_id(), authority(1, 2), limits(8, 1024)),
        Err(SessionStoreError::StaleAuthority)
    ));
    {
        SessionJournal::open(root.path(), session_id(), authority(2, 2), limits(8, 1024))
            .expect("advance authority");
    }
    assert!(matches!(
        SessionJournal::open(root.path(), session_id(), authority(1, 1), limits(8, 1024)),
        Err(SessionStoreError::StaleAuthority)
    ));
    SessionJournal::open(root.path(), session_id(), authority(2, 2), limits(8, 1024))
        .expect("same authority recovery");
}

#[test]
fn incomplete_authority_tail_is_truncated() {
    let root = TestRoot::new("authority-tail");
    {
        SessionJournal::open(root.path(), session_id(), authority(1, 1), limits(8, 1024))
            .expect("activate authority");
    }
    let authority_path = root
        .path()
        .join(session_id().as_str())
        .join("storage-authority.jsonl");
    let valid_length = fs::metadata(&authority_path)
        .expect("authority metadata")
        .len();
    let mut file = OpenOptions::new()
        .append(true)
        .open(&authority_path)
        .expect("open authority tail");
    file.write_all(b"{\"v\":1,\"transition\":2")
        .expect("append incomplete authority");
    file.sync_all().expect("sync authority tail");
    drop(file);

    SessionJournal::open(root.path(), session_id(), authority(1, 1), limits(8, 1024))
        .expect("recover authority tail");
    assert_eq!(
        fs::metadata(authority_path)
            .expect("recovered authority metadata")
            .len(),
        valid_length
    );
}

#[test]
fn authority_transition_limit_is_enforced() {
    let root = TestRoot::new("authority-limit");
    let tight_limits = SessionStoreLimits::new(8, 1024, 1).expect("tight limits");
    {
        SessionJournal::open(root.path(), session_id(), authority(1, 1), tight_limits)
            .expect("first authority");
    }
    assert!(matches!(
        SessionJournal::open(root.path(), session_id(), authority(2, 2), tight_limits),
        Err(SessionStoreError::AuthorityLimitExceeded)
    ));
}

#[test]
fn archive_is_authoritative_terminal_and_recoverable() {
    let root = TestRoot::new("archive");
    let archive_operation = operation_id(1);
    {
        let mut writer =
            SessionJournal::open(root.path(), session_id(), authority(1, 1), limits(8, 1024))
                .expect("open writer");
        assert!(matches!(
            writer.append(AppendRequest {
                operation_id: &archive_operation,
                kind: SessionRecordKind::Archive,
                durability: DurabilityClass::Durable,
                payload: b"",
            }),
            Err(SessionStoreError::ArchiveRequiresAuthoritativeDurability)
        ));
        writer
            .append(AppendRequest {
                operation_id: &archive_operation,
                kind: SessionRecordKind::Archive,
                durability: DurabilityClass::Authoritative,
                payload: b"",
            })
            .expect("archive");
        assert!(writer.snapshot().archived());
        assert!(matches!(
            writer.append(AppendRequest {
                operation_id: &operation_id(2),
                kind: SessionRecordKind::Conversation,
                durability: DurabilityClass::Durable,
                payload: b"late",
            }),
            Err(SessionStoreError::SessionArchived)
        ));
    }

    let mut reopened =
        SessionJournal::open(root.path(), session_id(), authority(2, 2), limits(8, 1024))
            .expect("recover archived session");
    assert!(reopened.snapshot().archived());
    let replay = reopened
        .append(AppendRequest {
            operation_id: &archive_operation,
            kind: SessionRecordKind::Archive,
            durability: DurabilityClass::Authoritative,
            payload: b"",
        })
        .expect("archive replay");
    assert!(matches!(replay, CommitOutcome::Replay(_)));
}
