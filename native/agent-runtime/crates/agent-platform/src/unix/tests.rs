use std::fs::{self, DirBuilder};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::Instant;

use crate::ipc::{
    EndpointName, ProtectedEndpointError, ProtectedEndpointFailure, endpoint_cancellation,
};

use super::ipc::{ExpectedUnixPeer, UnixEndpointCleanup, UnixProtectedEndpoint};

static NEXT_TEST: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
struct TestRoot(PathBuf);

impl TestRoot {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "cs-ipc-{:08x}-{:08x}",
            std::process::id(),
            NEXT_TEST.fetch_add(1, Ordering::Relaxed)
        ));
        let mut builder = DirBuilder::new();
        builder.mode(0o700);
        builder.create(&path).expect("private test root");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}

fn endpoint_name(label: &str) -> EndpointName {
    EndpointName::new(format!(
        "{label}-{:016x}",
        NEXT_TEST.fetch_add(1, Ordering::Relaxed)
    ))
    .expect("canonical test endpoint")
}

fn expected_peer(root: &TestRoot, process_id: u32) -> ExpectedUnixPeer {
    let user_id = fs::metadata(root.path()).expect("test root metadata").uid();
    ExpectedUnixPeer::new(process_id, user_id).expect("exact Unix peer")
}

fn drive_cleanup(failure: ProtectedEndpointFailure<UnixEndpointCleanup>) -> ProtectedEndpointError {
    match failure {
        ProtectedEndpointFailure::Clean(error) => error,
        ProtectedEndpointFailure::Owned { owner, error } => {
            owner.revoke().expect("conditional Unix cleanup");
            error
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn binds_private_socket_and_unlinks_before_exposing_stream() {
    let root = TestRoot::new();
    let endpoint = UnixProtectedEndpoint::bind(root.path(), &endpoint_name("verified-peer"))
        .expect("protected Unix endpoint");
    let socket_path = PathBuf::from(endpoint.address().as_str());
    let metadata = fs::symlink_metadata(&socket_path).expect("bound socket metadata");
    assert!(metadata.file_type().is_socket());
    assert_eq!(metadata.permissions().mode() & 0o777, 0o600);

    let (_client_cancel_handle, mut client_cancel) = endpoint_cancellation();
    let mut client = UnixProtectedEndpoint::connect(
        endpoint.address(),
        expected_peer(&root, std::process::id()),
        Instant::now() + Duration::from_secs(1),
        &mut client_cancel,
    )
    .await
    .expect("Unix client");
    let expected = expected_peer(&root, std::process::id());
    let (_accept_cancel_handle, mut accept_cancel) = endpoint_cancellation();
    let mut server = endpoint
        .accept(
            expected,
            Instant::now() + Duration::from_secs(1),
            &mut accept_cancel,
        )
        .await
        .expect("verified Unix peer");

    assert!(!socket_path.exists());
    assert!(!socket_path.parent().expect("leaf directory").exists());
    client.write_all(b"ping").await.expect("client write");
    let mut bytes = [0_u8; 4];
    server.read_exact(&mut bytes).await.expect("server read");
    assert_eq!(bytes, *b"ping");
    assert_eq!(server.peer().process_id(), std::process::id());
    assert_eq!(client.peer(), server.peer());
}

#[tokio::test(flavor = "current_thread")]
async fn collision_wrong_peer_deadline_and_cancel_all_revoke() {
    let root = TestRoot::new();
    let name = endpoint_name("single-owner");
    let endpoint = UnixProtectedEndpoint::bind(root.path(), &name).expect("first endpoint owner");
    assert!(UnixProtectedEndpoint::bind(root.path(), &name).is_err());
    endpoint.revoke().expect("explicit endpoint cleanup");

    let wrong_name = endpoint_name("wrong-peer");
    let endpoint =
        UnixProtectedEndpoint::bind(root.path(), &wrong_name).expect("wrong peer endpoint");
    let (_client_handle, mut client_cancel) = endpoint_cancellation();
    let client = UnixProtectedEndpoint::connect(
        endpoint.address(),
        expected_peer(&root, std::process::id()),
        Instant::now() + Duration::from_secs(1),
        &mut client_cancel,
    )
    .await
    .expect("same-user client");
    let wrong_pid = std::process::id().checked_add(1).expect("test PID");
    let (_accept_handle, mut accept_cancel) = endpoint_cancellation();
    let failure = endpoint
        .accept(
            expected_peer(&root, wrong_pid),
            Instant::now() + Duration::from_secs(1),
            &mut accept_cancel,
        )
        .await
        .expect_err("wrong first peer");
    drop(client);
    assert!(matches!(
        drive_cleanup(failure),
        ProtectedEndpointError::PeerMismatch { .. }
    ));

    let deadline_name = endpoint_name("deadline");
    let endpoint =
        UnixProtectedEndpoint::bind(root.path(), &deadline_name).expect("deadline endpoint");
    let (_handle, mut cancellation) = endpoint_cancellation();
    let failure = endpoint
        .accept(
            expected_peer(&root, std::process::id()),
            Instant::now(),
            &mut cancellation,
        )
        .await
        .expect_err("elapsed endpoint");
    assert!(matches!(
        drive_cleanup(failure),
        ProtectedEndpointError::DeadlineElapsed
    ));

    let cancel_name = endpoint_name("cancelled");
    let endpoint = UnixProtectedEndpoint::bind(root.path(), &cancel_name).expect("cancel endpoint");
    let (handle, mut cancellation) = endpoint_cancellation();
    handle.cancel();
    let failure = endpoint
        .accept(
            expected_peer(&root, std::process::id()),
            Instant::now() + Duration::from_secs(1),
            &mut cancellation,
        )
        .await
        .expect_err("cancelled endpoint");
    assert!(matches!(
        drive_cleanup(failure),
        ProtectedEndpointError::Cancelled
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn client_rejects_unexpected_server_pid_before_io() {
    let root = TestRoot::new();
    let endpoint = UnixProtectedEndpoint::bind(root.path(), &endpoint_name("wrong-server"))
        .expect("protected endpoint");
    let wrong_pid = std::process::id().checked_add(1).expect("test PID");
    let (_handle, mut cancellation) = endpoint_cancellation();

    let error = UnixProtectedEndpoint::connect(
        endpoint.address(),
        expected_peer(&root, wrong_pid),
        Instant::now() + Duration::from_secs(1),
        &mut cancellation,
    )
    .await
    .expect_err("client must reject the wrong server");
    assert!(matches!(
        error,
        ProtectedEndpointError::PeerMismatch {
            expected_process_id,
            actual_process_id: Some(actual),
        } if expected_process_id == wrong_pid && actual == std::process::id()
    ));
    endpoint
        .revoke()
        .expect("failed client verification leaves a revocable endpoint");
}

#[tokio::test(flavor = "current_thread")]
async fn cleanup_never_unlinks_a_replacement() {
    let root = TestRoot::new();
    let endpoint = UnixProtectedEndpoint::bind(root.path(), &endpoint_name("replacement"))
        .expect("protected endpoint");
    let socket = PathBuf::from(endpoint.address().as_str());
    fs::remove_file(&socket).expect("remove original socket path");
    fs::write(&socket, b"replacement").expect("create replacement");

    let failure = endpoint
        .revoke()
        .expect_err("identity mismatch must stay owned");
    let ProtectedEndpointFailure::Owned { owner, error } = failure else {
        panic!("cleanup identity mismatch retains owner");
    };
    assert!(matches!(
        error,
        ProtectedEndpointError::CleanupIdentityMismatch
    ));
    assert_eq!(
        fs::read(&socket).expect("replacement remains"),
        b"replacement"
    );

    fs::remove_file(&socket).expect("remove test replacement");
    owner
        .revoke()
        .expect("retry cleanup after replacement removal");
}

#[tokio::test(flavor = "current_thread")]
async fn insecure_root_is_rejected_without_modification() {
    let root = TestRoot::new();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o755))
        .expect("make root intentionally insecure");

    let error = UnixProtectedEndpoint::bind(root.path(), &endpoint_name("insecure-root"))
        .expect_err("group-readable root must fail");
    assert!(matches!(
        error,
        ProtectedEndpointFailure::Clean(ProtectedEndpointError::PermissionNotProven {
            object: "local IPC root",
            ..
        })
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn symlink_in_root_ancestry_is_rejected_without_modification() {
    let root = TestRoot::new();
    let real_parent = root.path().join("real");
    let real_root = real_parent.join("private");
    let alias = root.path().join("alias");
    fs::create_dir(&real_parent).expect("real parent");
    fs::create_dir(&real_root).expect("real private root");
    fs::set_permissions(&real_root, fs::Permissions::from_mode(0o700)).expect("private root mode");
    symlink(&real_parent, &alias).expect("ancestor symlink");
    let aliased_root = alias.join("private");

    let error = UnixProtectedEndpoint::bind(&aliased_root, &endpoint_name("symlink-root"))
        .expect_err("symlink ancestry must fail closed");
    assert!(matches!(
        error,
        ProtectedEndpointFailure::Clean(ProtectedEndpointError::InvalidRoot(_))
    ));
    assert!(
        fs::read_dir(&real_root)
            .expect("real root remains")
            .next()
            .is_none()
    );

    fs::remove_file(&alias).expect("remove test symlink");
    fs::remove_dir(&real_root).expect("remove private root");
    fs::remove_dir(&real_parent).expect("remove real parent");
}
