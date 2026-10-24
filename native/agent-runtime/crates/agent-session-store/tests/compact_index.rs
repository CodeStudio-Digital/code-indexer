use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use agent_session_store::{
    AppendRequest, CommitOutcome, DurabilityClass, LeaseEpoch, ListCommittedRecordsRequest,
    OperationId, ReadCommittedPayloadRequest, SessionId, SessionJournal, SessionReadView,
    SessionRecordKind, SessionStoreError, SessionStoreLimits, StorageAuthority, WriterId,
};

static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);
struct TestRoot(PathBuf);
impl TestRoot {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "codestudio-compact-index-{}-{}",
            std::process::id(),
            NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for TestRoot {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn session() -> SessionId {
    SessionId::parse("10000000-0000-0000-0000-000000000001").unwrap()
}
fn authority(epoch: u64) -> StorageAuthority {
    StorageAuthority::rust_fs_v1(
        LeaseEpoch::new(epoch).unwrap(),
        WriterId::parse(format!("20000000-0000-0000-0000-{epoch:012x}")).unwrap(),
    )
}
fn operation(value: u64) -> OperationId {
    OperationId::parse(format!("30000000-0000-0000-0000-{value:012x}")).unwrap()
}
fn append(journal: &mut SessionJournal, value: u64) -> CommitOutcome {
    journal
        .append(AppendRequest {
            operation_id: &operation(value),
            kind: SessionRecordKind::Conversation,
            durability: DurabilityClass::Durable,
            payload: b"bounded physical journal fixture",
        })
        .unwrap()
}

#[test]
fn compact_index_preserves_commit_order_and_exact_lookup_after_recovery() {
    verify_scale(513);
}

/// Physical commits and recovery, not model turns. Run explicitly to measure
/// the current reader ceiling without adding a long benchmark to normal tests.
#[test]
#[ignore = "explicit physical scale benchmark"]
fn compact_index_physical_scale_at_reader_ceiling() {
    verify_scale(100_000);
}

fn verify_scale(count: u64) {
    let root = TestRoot::new();
    let limits = SessionStoreLimits::new(count + 1, 1024, 8).unwrap();
    let mut journal = SessionJournal::open(&root.0, session(), authority(1), limits).unwrap();
    let started = Instant::now();
    // Identity order deliberately opposes sequence order. Index lookups and
    // pages must use commit order regardless of HashMap iteration or UUID sort.
    for value in (1..=count).rev() {
        assert!(matches!(
            append(&mut journal, value),
            CommitOutcome::Committed(_)
        ));
    }
    let append_ms = started.elapsed().as_secs_f64() * 1000.0;
    for value in [1, count / 2, count] {
        let result = append(&mut journal, value);
        assert!(matches!(result, CommitOutcome::Replay(_)));
        assert_eq!(result.receipt().sequence(), count - value + 1);
    }
    drop(journal);

    let started = Instant::now();
    let view = SessionReadView::open(&root.0, session(), &authority(1), limits).unwrap();
    let reader_open_ms = started.elapsed().as_secs_f64() * 1000.0;
    let started = Instant::now();
    let mut cursor = 0;
    let mut snapshot = String::new();
    loop {
        let page = view
            .list(
                ListCommittedRecordsRequest {
                    after_sequence: cursor,
                    maximum_records: 256,
                },
                &snapshot,
            )
            .unwrap();
        if !snapshot.is_empty() {
            assert_eq!(snapshot, page.snapshot_id());
        }
        page.snapshot_id().clone_into(&mut snapshot);
        for receipt in page.records() {
            cursor += 1;
            assert_eq!(receipt.sequence(), cursor);
            assert_eq!(receipt.operation_id(), &operation(count - cursor + 1));
        }
        if let Some(receipt) = page.records().last() {
            let request = ReadCommittedPayloadRequest {
                operation_id: receipt.operation_id(),
                kind: receipt.kind(),
                expected_payload_sha256: receipt.payload_hash(),
                expected_payload_bytes: receipt.payload_bytes(),
                maximum_payload_bytes: 1024,
            };
            assert_eq!(view.read(request).unwrap().receipt(), receipt);
            assert!(matches!(
                view.read(ReadCommittedPayloadRequest {
                    expected_payload_sha256: [0; 32],
                    ..request
                }),
                Err(SessionStoreError::DivergentReplay)
            ));
        }
        assert_eq!(cursor, page.next_sequence());
        if page.complete() {
            break;
        }
    }
    assert_eq!(cursor, count);
    let reader_page_ms = started.elapsed().as_secs_f64() * 1000.0;
    drop(view);

    let started = Instant::now();
    let mut journal = SessionJournal::open(&root.0, session(), authority(2), limits).unwrap();
    let writer_reopen_ms = started.elapsed().as_secs_f64() * 1000.0;
    for value in [count, count / 2, 1] {
        let result = append(&mut journal, value);
        assert!(matches!(result, CommitOutcome::Replay(_)));
        assert_eq!(result.receipt().sequence(), count - value + 1);
        assert_eq!(result.receipt().lease_epoch().get(), 1);
    }
    assert!(matches!(
        journal.append(AppendRequest {
            operation_id: &operation(1),
            kind: SessionRecordKind::Conversation,
            durability: DurabilityClass::Durable,
            payload: b"divergent",
        }),
        Err(SessionStoreError::DivergentReplay)
    ));
    assert_eq!(journal.committed_records(), count);
    assert_eq!(
        append(&mut journal, count + 1).receipt().sequence(),
        count + 1
    );
    println!(
        "compact_index records={count} pid={} append_ms={append_ms:.3} reader_open_ms={reader_open_ms:.3} reader_page_ms={reader_page_ms:.3} writer_reopen_ms={writer_reopen_ms:.3}",
        std::process::id()
    );
}
