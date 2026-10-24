use std::fmt::Write as _;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use agent_session_store::{
    AppendRequest, CommitOutcome, DurabilityClass, LeaseEpoch, ListCommittedRecordsRequest,
    OperationId, ReadCommittedPayloadRequest, SessionId, SessionJournal, SessionReadView,
    SessionRecordKind, SessionStoreError, SessionStoreLimits, StorageAuthority, StorageGeneration,
    WriterId,
};

static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

#[test]
fn read_view_never_acquires_or_replaces_a_live_writer() {
    let root = TestRoot::new("read-view-live");
    let mut journal =
        SessionJournal::open(root.path(), session_id(), authority(1, 1), limits(8, 1024)).unwrap();
    let first = operation_id(1);
    journal
        .append(AppendRequest {
            operation_id: &first,
            kind: SessionRecordKind::Conversation,
            durability: DurabilityClass::Authoritative,
            payload: b"message",
        })
        .unwrap();
    let view = SessionReadView::open(root.path(), session_id(), &authority(1, 1), limits(8, 1024))
        .unwrap();
    let page = view
        .list(
            ListCommittedRecordsRequest {
                after_sequence: 0,
                maximum_records: 1,
            },
            "",
        )
        .unwrap();
    assert_eq!(page.records().len(), 1);
    let receipt = &page.records()[0];
    let payload = view
        .read(ReadCommittedPayloadRequest {
            operation_id: &first,
            kind: receipt.kind(),
            expected_payload_sha256: receipt.payload_hash(),
            expected_payload_bytes: receipt.payload_bytes(),
            maximum_payload_bytes: 1024,
        })
        .unwrap();
    assert_eq!(payload.encoded_payload(), b"message");
    assert!(matches!(
        SessionReadView::open(root.path(), session_id(), &authority(2, 2), limits(8, 1024)),
        Err(SessionStoreError::StaleAuthority)
    ));
    journal
        .append(AppendRequest {
            operation_id: &operation_id(2),
            kind: SessionRecordKind::Conversation,
            durability: DurabilityClass::Authoritative,
            payload: b"next",
        })
        .unwrap();
    assert!(matches!(
        view.list(
            ListCommittedRecordsRequest {
                after_sequence: 1,
                maximum_records: 1
            },
            page.snapshot_id()
        ),
        Err(SessionStoreError::ConcurrentMutation)
    ));
    drop(journal);
    let reopened =
        SessionReadView::open(root.path(), session_id(), &authority(1, 1), limits(8, 1024))
            .unwrap();
    assert_eq!(reopened.snapshot().unwrap().committed_records(), 2);
    let writer =
        SessionJournal::open(root.path(), session_id(), authority(2, 2), limits(8, 1024)).unwrap();
    assert!(matches!(
        reopened.snapshot(),
        Err(SessionStoreError::ConcurrentMutation)
    ));
    drop(writer);
}

#[test]
fn read_view_does_not_repair_or_create_storage() {
    let root = TestRoot::new("read-view-tail");
    assert!(
        SessionReadView::open(root.path(), session_id(), &authority(1, 1), limits(8, 1024))
            .is_err()
    );
    assert!(!root.path().join(session_id().as_str()).exists());
    let mut journal =
        SessionJournal::open(root.path(), session_id(), authority(1, 1), limits(8, 1024)).unwrap();
    journal
        .append(AppendRequest {
            operation_id: &operation_id(1),
            kind: SessionRecordKind::Conversation,
            durability: DurabilityClass::Authoritative,
            payload: b"committed",
        })
        .unwrap();
    drop(journal);
    let path = root
        .path()
        .join(session_id().as_str())
        .join("conversation.jsonl");
    OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"uncommitted-tail")
        .unwrap();
    let before = fs::read(&path).unwrap();
    let lease_path = root
        .path()
        .join(session_id().as_str())
        .join(".rust-writer.lease");
    let lease_before = fs::read(&lease_path).unwrap();
    let view = SessionReadView::open(root.path(), session_id(), &authority(1, 1), limits(8, 1024))
        .unwrap();
    assert_eq!(view.snapshot().unwrap().committed_records(), 1);
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(fs::read(lease_path).unwrap(), lease_before);
}

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
fn committed_record_cursor_is_bounded_ordered_and_complete() {
    let root = TestRoot::new("record-page");
    let mut journal =
        SessionJournal::open(root.path(), session_id(), authority(1, 1), limits(8, 1024))
            .expect("open writer");
    for value in 1..=3 {
        journal
            .append(AppendRequest {
                operation_id: &operation_id(value),
                kind: SessionRecordKind::LifecycleEvent,
                durability: DurabilityClass::Authoritative,
                payload: &[value],
            })
            .expect("commit record");
    }

    let first = journal
        .list_committed_records(ListCommittedRecordsRequest {
            after_sequence: 0,
            maximum_records: 2,
        })
        .expect("first page");
    assert_eq!(
        first
            .records()
            .iter()
            .map(agent_session_store::CommitReceipt::sequence)
            .collect::<Vec<_>>(),
        [1, 2]
    );
    assert_eq!(first.next_sequence(), 2);
    assert!(!first.complete());

    let second = journal
        .list_committed_records(ListCommittedRecordsRequest {
            after_sequence: first.next_sequence(),
            maximum_records: 2,
        })
        .expect("second page");
    assert_eq!(second.records().len(), 1);
    assert_eq!(second.records()[0].sequence(), 3);
    assert_eq!(second.next_sequence(), 3);
    assert!(second.complete());
    assert!(matches!(
        journal.list_committed_records(ListCommittedRecordsRequest {
            after_sequence: 4,
            maximum_records: 1,
        }),
        Err(SessionStoreError::InvalidLimits)
    ));
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
fn snapshot_pages_preserve_frozen_records_across_authorized_commits() {
    let root = TestRoot::new("snapshot-pages");
    let mut journal =
        SessionJournal::open(root.path(), session_id(), authority(1, 1), limits(8, 1024))
            .expect("writer");
    for value in 1..=3 {
        journal
            .append(AppendRequest {
                operation_id: &operation_id(value),
                kind: SessionRecordKind::Conversation,
                durability: DurabilityClass::Durable,
                payload: b"hello",
            })
            .expect("append");
    }
    let first = journal
        .list_committed_snapshot(
            ListCommittedRecordsRequest {
                after_sequence: 0,
                maximum_records: 1,
            },
            "",
        )
        .expect("snapshot");
    let second = journal
        .list_committed_snapshot(
            ListCommittedRecordsRequest {
                after_sequence: 1,
                maximum_records: 2,
            },
            first.snapshot_id(),
        )
        .expect("page");
    assert_eq!(first.snapshot_id(), second.snapshot_id());
    assert_eq!(
        second
            .records()
            .iter()
            .map(agent_session_store::CommitReceipt::sequence)
            .collect::<Vec<_>>(),
        [2, 3]
    );
    assert!(second.complete());
    journal
        .append(AppendRequest {
            operation_id: &operation_id(4),
            kind: SessionRecordKind::Conversation,
            durability: DurabilityClass::Durable,
            payload: b"next",
        })
        .expect("authorized append");
    let frozen = journal
        .list_committed_snapshot(
            ListCommittedRecordsRequest {
                after_sequence: 1,
                maximum_records: 2,
            },
            first.snapshot_id(),
        )
        .expect("frozen page survives authorized append");
    assert_eq!(frozen.records().len(), 2);
    assert_eq!(frozen.records().last().unwrap().sequence(), 3);
    assert!(frozen.complete());
    assert!(matches!(
        journal.list_committed_snapshot(
            ListCommittedRecordsRequest {
                after_sequence: 4,
                maximum_records: 1,
            },
            first.snapshot_id()
        ),
        Err(SessionStoreError::InvalidLimits)
    ));
    let fresh = journal
        .list_committed_snapshot(
            ListCommittedRecordsRequest {
                after_sequence: 0,
                maximum_records: 8,
            },
            "",
        )
        .expect("new snapshot");
    assert_ne!(fresh.snapshot_id(), first.snapshot_id());
    assert_eq!(fresh.records().len(), 4);
}

#[test]
fn snapshot_rejects_same_length_external_mutation() {
    let root = TestRoot::new("snapshot-corruption");
    let mut journal =
        SessionJournal::open(root.path(), session_id(), authority(1, 1), limits(8, 1024))
            .expect("writer");
    journal
        .append(AppendRequest {
            operation_id: &operation_id(1),
            kind: SessionRecordKind::Conversation,
            durability: DurabilityClass::Durable,
            payload: b"hello",
        })
        .expect("append");
    let first = journal
        .list_committed_snapshot(
            ListCommittedRecordsRequest {
                after_sequence: 0,
                maximum_records: 1,
            },
            "",
        )
        .expect("snapshot");
    let path = root
        .path()
        .join(session_id().as_str())
        .join("conversation.jsonl");
    let mut bytes = fs::read(&path).expect("read journal");
    bytes[0] = b'!';
    fs::write(&path, bytes).expect("same length corruption");
    std::fs::File::options()
        .write(true)
        .open(&path)
        .expect("file")
        .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(2))
        .expect("distinct timestamp");
    assert!(matches!(
        journal.list_committed_snapshot(
            ListCommittedRecordsRequest {
                after_sequence: 0,
                maximum_records: 1,
            },
            first.snapshot_id()
        ),
        Err(SessionStoreError::ConcurrentMutation)
    ));
    assert!(
        journal
            .list_committed_snapshot(
                ListCommittedRecordsRequest {
                    after_sequence: 0,
                    maximum_records: 1,
                },
                ""
            )
            .is_err()
    );
}

#[test]
fn recovery_snapshot_pages_scale_to_ten_thousand_records() {
    for count in [100_u64, 1_000, 10_000] {
        let root = TestRoot::new("snapshot-scale");
        let mut journal = SessionJournal::open(
            root.path(),
            session_id(),
            authority(1, 1),
            limits(count, 1024),
        )
        .expect("writer");
        for value in 1..=count {
            journal
                .append(AppendRequest {
                    operation_id: &OperationId::parse(format!(
                        "30000000-0000-0000-0000-{value:012x}"
                    ))
                    .expect("operation"),
                    kind: SessionRecordKind::Conversation,
                    durability: DurabilityClass::Durable,
                    payload: b"synthetic recovery record",
                })
                .expect("append");
        }
        let started = std::time::Instant::now();
        let mut cursor = 0;
        loop {
            let page = journal
                .list_committed_records(ListCommittedRecordsRequest {
                    after_sequence: cursor,
                    maximum_records: 256,
                })
                .expect("revalidated page");
            cursor = page.next_sequence();
            if page.complete() {
                break;
            }
        }
        let fresh_snapshot_ms = started.elapsed().as_secs_f64() * 1_000.0;
        let started = std::time::Instant::now();
        let mut cursor = 0;
        let mut snapshot_id = String::new();
        let mut received = 0;
        loop {
            let page = journal
                .list_committed_snapshot(
                    ListCommittedRecordsRequest {
                        after_sequence: cursor,
                        maximum_records: 256,
                    },
                    &snapshot_id,
                )
                .expect("snapshot page");
            if !snapshot_id.is_empty() {
                assert_eq!(snapshot_id, page.snapshot_id());
            }
            snapshot_id = page.snapshot_id().to_owned();
            for receipt in page.records() {
                received += 1;
                assert_eq!(receipt.sequence(), received);
            }
            cursor = page.next_sequence();
            if page.complete() {
                break;
            }
        }
        assert_eq!(received, count);
        println!(
            "snapshot_records={count} fresh_snapshot_each_page_ms={fresh_snapshot_ms:.3} frozen_snapshot_ms={:.3}",
            started.elapsed().as_secs_f64() * 1_000.0
        );
    }
}

#[test]
#[cfg(windows)]
fn warmed_snapshots_and_appends_do_not_reopen_the_journal_for_reading() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = TestRoot::new("no-journal-reread");
    let mut journal =
        SessionJournal::open(root.path(), session_id(), authority(1, 1), limits(64, 1024)).unwrap();
    for id in 1..=32 {
        journal
            .append(AppendRequest {
                operation_id: &operation_id(id),
                kind: SessionRecordKind::Conversation,
                durability: DurabilityClass::Durable,
                payload: b"committed",
            })
            .unwrap();
    }
    drop(journal);
    let mut journal =
        SessionJournal::open(root.path(), session_id(), authority(2, 2), limits(64, 1024)).unwrap();
    let path = root
        .path()
        .join(session_id().as_str())
        .join("conversation.jsonl");
    // The kernel now rejects all new data-read handles. Metadata and the
    // authorized writer's existing append handle remain available.
    let no_reads = OpenOptions::new()
        .write(true)
        .share_mode(2)
        .open(&path)
        .unwrap();
    assert!(std::fs::File::open(&path).is_err());
    let first = journal
        .list_committed_records(ListCommittedRecordsRequest {
            after_sequence: 0,
            maximum_records: 16,
        })
        .unwrap();
    assert_eq!(first.records().len(), 16);
    for id in 33..=40 {
        journal
            .append(AppendRequest {
                operation_id: &operation_id(id),
                kind: SessionRecordKind::Conversation,
                durability: DurabilityClass::Durable,
                payload: b"incremental",
            })
            .unwrap();
    }
    let frozen = journal
        .list_committed_snapshot(
            ListCommittedRecordsRequest {
                after_sequence: 16,
                maximum_records: 64,
            },
            first.snapshot_id(),
        )
        .unwrap();
    assert_eq!(frozen.records().len(), 16);
    assert!(frozen.complete());
    for _ in 0..8 {
        let fresh = journal
            .list_committed_records(ListCommittedRecordsRequest {
                after_sequence: 32,
                maximum_records: 64,
            })
            .unwrap();
        assert_eq!(fresh.records().len(), 8);
        assert_eq!(fresh.next_sequence(), 40);
    }
    drop(no_reads);
    drop(journal);
    let mut reopened =
        SessionJournal::open(root.path(), session_id(), authority(3, 3), limits(64, 1024)).unwrap();
    assert_eq!(
        reopened
            .list_committed_records(ListCommittedRecordsRequest {
                after_sequence: 0,
                maximum_records: 64,
            })
            .unwrap()
            .records()
            .len(),
        40
    );
}

#[test]
fn mutation_before_first_snapshot_cannot_be_blessed_by_the_cached_index() {
    let root = TestRoot::new("index-corruption");
    let mut journal =
        SessionJournal::open(root.path(), session_id(), authority(1, 1), limits(8, 1024)).unwrap();
    journal
        .append(AppendRequest {
            operation_id: &operation_id(1),
            kind: SessionRecordKind::Conversation,
            durability: DurabilityClass::Durable,
            payload: b"committed",
        })
        .unwrap();
    let path = root
        .path()
        .join(session_id().as_str())
        .join("conversation.jsonl");
    let mut bytes = fs::read(&path).unwrap();
    bytes[0] = b'!';
    fs::write(&path, bytes).unwrap();
    OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(2))
        .unwrap();
    assert!(matches!(
        journal.list_committed_records(ListCommittedRecordsRequest {
            after_sequence: 0,
            maximum_records: 1,
        }),
        Err(SessionStoreError::ConcurrentMutation)
    ));
    assert!(matches!(
        journal.append(AppendRequest {
            operation_id: &operation_id(2),
            kind: SessionRecordKind::Conversation,
            durability: DurabilityClass::Durable,
            payload: b"must not commit",
        }),
        Err(SessionStoreError::Poisoned)
    ));
    drop(journal);
    assert!(
        SessionJournal::open(root.path(), session_id(), authority(2, 2), limits(8, 1024)).is_err()
    );
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
