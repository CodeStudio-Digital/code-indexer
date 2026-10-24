use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "native-outbox-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).expect("isolated root");
        Self(root)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn entry() -> wire::SupervisorLifecycleOutboxEntryV1 {
    let identity = wire::AttemptIdentity {
        attempt_id: "attempt-1".into(),
        ..Default::default()
    };
    wire::SupervisorLifecycleOutboxEntryV1 {
        schema_version: 1,
        connection_id: "connection-1".into(),
        exited: Some(wire::AttemptProcessExited {
            identity: Some(identity.clone()),
            exited_at_unix_ms: 100,
            runner_provenance: Some(wire::RuntimeProvenance {
                pid: 41,
                runtime_instance_id: "runtime-1".into(),
                binary_sha256: vec![3; 32],
                ..Default::default()
            }),
            ..Default::default()
        }),
        reaped: Some(wire::AttemptProcessReaped {
            identity: Some(identity),
            reaped_at_unix_ms: 200,
            runtime_instance_id: "runtime-1".into(),
            resource_group_id: "group-1".into(),
            released_resources: vec![wire::ReleasedResource {
                resource_id: "pid:41".into(),
                released_count: 1,
                ..Default::default()
            }],
        }),
        host_acknowledged: false,
    }
}

#[test]
fn survives_reopen_and_ack_loss_without_releasing_pending_evidence() {
    let fixture = Fixture::new();
    let mut outbox = DurableLifecycleOutbox::open(&fixture.0, "connection-1").expect("open");
    outbox.stage(entry()).expect("stage");
    outbox.stage(entry()).expect("exact stage replay");
    let mut changed = entry();
    changed.exited.as_mut().expect("exit").exit_code = Some(9);
    assert!(outbox.stage(changed).is_err());
    assert!(DurableLifecycleOutbox::open(&fixture.0, "connection-1").is_err());
    drop(outbox);
    let mut outbox = DurableLifecycleOutbox::open(&fixture.0, "connection-1").expect("reopen");
    assert_eq!(outbox.pending(), vec![entry()]);
    assert!(outbox.acknowledge("another-attempt").is_err());
    outbox.acknowledge("attempt-1").expect("durable Host ACK");
    drop(outbox);
    assert!(
        DurableLifecycleOutbox::open(&fixture.0, "connection-1")
            .expect("reopen ACK")
            .pending()
            .is_empty()
    );
    assert!(DurableLifecycleOutbox::open(&fixture.0, "foreign-connection").is_err());
}

#[test]
fn corrupt_or_partial_tail_is_not_repaired_into_a_false_ack() {
    for corrupt in [false, true] {
        let fixture = Fixture::new();
        let mut outbox = DurableLifecycleOutbox::open(&fixture.0, "connection-1").expect("open");
        outbox.stage(entry()).expect("stage");
        drop(outbox);
        let path = fixture.0.join("lifecycle.wal");
        let mut bytes = std::fs::read(&path).expect("read");
        if corrupt {
            bytes[5] ^= 1;
        } else {
            bytes.push(3);
        }
        std::fs::write(&path, &bytes).expect("damage");
        assert!(DurableLifecycleOutbox::open(&fixture.0, "connection-1").is_err());
        assert_eq!(std::fs::read(&path).expect("preserved"), bytes);
    }
}

#[test]
fn real_process_death_retains_evidence_and_releases_the_os_lock() {
    let fixture = Fixture::new();
    let mut child = std::process::Command::new(std::env::current_exe().expect("test executable"))
        .args(["--exact", "tests::outbox_child", "--ignored", "--nocapture"])
        .env("CODESTUDIO_OUTBOX_CHILD_ROOT", &fixture.0)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("child");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !fixture.0.join("ready").exists() && std::time::Instant::now() < deadline {
        assert!(
            child.try_wait().expect("child status").is_none(),
            "child exited before staging"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let ready = fixture.0.join("ready").exists();
    let locked = DurableLifecycleOutbox::open(&fixture.0, "connection-1").is_err();
    child.kill().expect("kill child");
    child.wait().expect("reap child");
    assert!(ready && locked);
    let recovered =
        DurableLifecycleOutbox::open(&fixture.0, "connection-1").expect("post-crash lock");
    assert_eq!(recovered.pending(), vec![entry()]);
}

#[test]
#[ignore = "subprocess helper invoked by real_process_death test"]
fn outbox_child() {
    let root =
        PathBuf::from(std::env::var_os("CODESTUDIO_OUTBOX_CHILD_ROOT").expect("isolated root"));
    let mut outbox = DurableLifecycleOutbox::open(&root, "connection-1").expect("open");
    outbox.stage(entry()).expect("stage");
    std::fs::write(root.join("ready"), b"ready").expect("ready");
    loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
}
