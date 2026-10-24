use agent_session_store::{
    AppendRequest, DurabilityClass, LeaseEpoch, OperationId, SessionId, SessionJournal,
    SessionRecordKind, SessionStoreError, SessionStoreLimits, StorageAuthority, StorageRootLock,
    WriterId,
};
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const SESSION: &str = "10000000-0000-0000-0000-000000000001";
const OPERATION: &str = "30000000-0000-0000-0000-000000000001";

fn authority(epoch: u64) -> StorageAuthority {
    StorageAuthority::rust_fs_v1(
        LeaseEpoch::new(epoch).unwrap(),
        WriterId::parse(format!("20000000-0000-0000-0000-{epoch:012x}")).unwrap(),
    )
}
fn open(root: &Path, epoch: u64) -> Result<SessionJournal, SessionStoreError> {
    SessionJournal::open(
        root,
        SessionId::parse(SESSION).unwrap(),
        authority(epoch),
        SessionStoreLimits::new(16, 1024, 16).unwrap(),
    )
}

#[test]
fn process_exit_releases_os_lock_without_repeating_a_committed_effect() {
    let root = std::env::temp_dir().join(format!("native-writer-crash-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "writer_crash_child", "--ignored"])
        .env("NATIVE_WRITER_CRASH_ROOT", &root)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let ready = root.join("ready");
    let started = Instant::now();
    while !ready.exists() && started.elapsed() < Duration::from_secs(10) {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    if !ready.exists() {
        let _ = child.kill();
        let _ = child.wait();
        panic!("writer child failed to start");
    }
    assert!(matches!(
        open(&root, 2),
        Err(SessionStoreError::WriterAlreadyActive)
    ));
    assert!(matches!(
        StorageRootLock::acquire(&root, "workspace-leases"),
        Err(SessionStoreError::StorageLockBusy)
    ));
    child.kill().unwrap();
    child.wait().unwrap();
    drop(
        StorageRootLock::acquire(&root, "workspace-leases")
            .expect("OS root mutex recovered after process death"),
    );
    let mut recovered = open(&root, 2).expect("OS lock recovered after process death");
    assert_eq!(recovered.snapshot().committed_records(), 1);
    let operation = OperationId::parse(OPERATION).unwrap();
    let receipt = recovered
        .append(AppendRequest {
            operation_id: &operation,
            kind: SessionRecordKind::Conversation,
            durability: DurabilityClass::Authoritative,
            payload: b"effect-receipt",
        })
        .unwrap();
    assert!(matches!(
        receipt,
        agent_session_store::CommitOutcome::Replay(_)
    ));
    assert_eq!(recovered.snapshot().committed_records(), 1);
    drop(recovered);
    assert!(matches!(
        open(&root, 1),
        Err(SessionStoreError::StaleAuthority)
    ));
    fs::remove_dir_all(root).unwrap();
}

#[test]
#[ignore = "launched only by the parent crash/recovery test"]
fn writer_crash_child() {
    let root = std::env::var_os("NATIVE_WRITER_CRASH_ROOT").expect("parent fixture root");
    let root = Path::new(&root);
    let _transaction = StorageRootLock::acquire(root, "workspace-leases").unwrap();
    let mut writer = open(root, 1).unwrap();
    writer
        .append(AppendRequest {
            operation_id: &OperationId::parse(OPERATION).unwrap(),
            kind: SessionRecordKind::Conversation,
            durability: DurabilityClass::Authoritative,
            payload: b"effect-receipt",
        })
        .unwrap();
    fs::write(root.join("ready"), b"ready").unwrap();
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}

#[test]
fn legacy_exclusive_create_lease_is_not_stolen_by_the_new_os_lock() {
    let root = std::env::temp_dir().join(format!("native-writer-old-lock-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    drop(open(&root, 1).unwrap());
    let lease = root.join(SESSION).join(".rust-writer.lease");
    let old_owner = "rust_fs_v1 1 20000000-0000-0000-0000-000000000001\n";
    fs::write(&lease, old_owner).unwrap();
    assert!(matches!(
        open(&root, 2),
        Err(SessionStoreError::WriterAlreadyActive)
    ));
    assert_eq!(fs::read_to_string(lease).unwrap(), old_owner);
    fs::remove_dir_all(root).unwrap();
}
