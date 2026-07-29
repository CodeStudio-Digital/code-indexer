use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::Instant;

use crate::ipc::{
    EndpointBufferCapacity, EndpointName, ExpectedLocalPeer, ProtectedEndpointError,
    ProtectedEndpointFailure, endpoint_cancellation,
};

use super::super::ipc::{WindowsEndpointCleanup, WindowsProtectedEndpoint, current_logon_acl_sddl};

static NEXT_ENDPOINT: AtomicU64 = AtomicU64::new(1);

fn endpoint_name(label: &str) -> EndpointName {
    EndpointName::new(format!(
        "{label}-{:08x}-{:016x}",
        std::process::id(),
        NEXT_ENDPOINT.fetch_add(1, Ordering::Relaxed)
    ))
    .expect("unique canonical endpoint name")
}

fn capacity() -> EndpointBufferCapacity {
    EndpointBufferCapacity::new(64 * 1_024).expect("bounded pipe buffer")
}

async fn drive_cleanup(
    failure: ProtectedEndpointFailure<WindowsEndpointCleanup>,
) -> ProtectedEndpointError {
    match failure {
        ProtectedEndpointFailure::Clean(error) => error,
        ProtectedEndpointFailure::Owned { owner, error } => {
            owner
                .reap(Instant::now() + Duration::from_secs(1))
                .await
                .expect("bounded pipe cleanup");
            error
        }
    }
}

#[test]
fn endpoint_names_make_paths_and_case_aliases_unrepresentable() {
    for invalid in [
        "short",
        r"../../escape-0000000000000000",
        r"\\server\pipe\remote",
        "UPPERCASE-0000000000000000",
        "-leading-0000000000000000",
        "trailing-0000000000000000-",
    ] {
        assert!(matches!(
            EndpointName::new(invalid),
            Err(ProtectedEndpointError::InvalidName)
        ));
    }
}

#[tokio::test(flavor = "current_thread")]
async fn acl_is_protected_and_grants_only_system_and_current_logon() {
    let sddl = current_logon_acl_sddl().expect("current logon SID ACL");

    assert!(sddl.starts_with("D:P"));
    assert!(sddl.contains("(A;;GA;;;SY)"));
    assert_eq!(sddl.matches("(A;;GA;;;").count(), 2);
    assert!(!sddl.contains(";;;WD)"));
    assert!(!sddl.contains(";;;AN)"));
    assert!(!sddl.contains(";;;BA)"));
}

#[tokio::test(flavor = "current_thread")]
async fn first_instance_and_drop_make_ownership_linear() {
    let name = endpoint_name("single-owner");
    let endpoint = WindowsProtectedEndpoint::bind(&name, capacity()).expect("first pipe instance");

    assert!(WindowsProtectedEndpoint::bind(&name, capacity()).is_err());
    drop(endpoint);
    WindowsProtectedEndpoint::bind(&name, capacity())
        .expect("drop releases the only pipe name")
        .revoke(Instant::now() + Duration::from_secs(1))
        .await
        .expect("explicit revocation proves name release");
}

#[tokio::test(flavor = "current_thread")]
async fn exact_peer_pid_is_verified_before_stream_io() {
    let endpoint = WindowsProtectedEndpoint::bind(&endpoint_name("verified-peer"), capacity())
        .expect("protected server");
    let expected = ExpectedLocalPeer::new(std::process::id()).expect("current process peer");
    let mut client = WindowsProtectedEndpoint::connect(endpoint.address(), expected)
        .expect("verified local pipe server");
    let (_cancel_handle, mut cancellation) = endpoint_cancellation();
    let mut server = endpoint
        .accept(
            expected,
            Instant::now() + Duration::from_secs(1),
            &mut cancellation,
        )
        .await
        .expect("verified pipe peer");

    client.write_all(b"ping").await.expect("client write");
    let mut received = [0_u8; 4];
    server.read_exact(&mut received).await.expect("server read");

    assert_eq!(received, *b"ping");
    assert_eq!(server.peer().process_id(), std::process::id());
    assert_eq!(client.peer(), server.peer());
}

#[tokio::test(flavor = "current_thread")]
async fn wrong_first_peer_revokes_without_retry() {
    let name = endpoint_name("wrong-first-peer");
    let endpoint = WindowsProtectedEndpoint::bind(&name, capacity()).expect("protected server");
    let local = ExpectedLocalPeer::new(std::process::id()).expect("current process peer");
    let client = WindowsProtectedEndpoint::connect(endpoint.address(), local)
        .expect("verified local server");
    let wrong_pid = std::process::id().checked_add(1).expect("test PID");
    let expected = ExpectedLocalPeer::new(wrong_pid).expect("nonzero PID");
    let (_cancel_handle, mut cancellation) = endpoint_cancellation();
    let failure = endpoint
        .accept(
            expected,
            Instant::now() + Duration::from_secs(1),
            &mut cancellation,
        )
        .await
        .expect_err("wrong peer must fail closed");
    drop(client);
    let error = drive_cleanup(failure).await;

    assert!(matches!(
        error,
        ProtectedEndpointError::PeerMismatch {
            expected_process_id,
            actual_process_id: Some(actual),
        } if expected_process_id == wrong_pid && actual == std::process::id()
    ));
    WindowsProtectedEndpoint::bind(&name, capacity())
        .expect("mismatch dropped the poisoned instance")
        .revoke(Instant::now() + Duration::from_secs(1))
        .await
        .expect("mismatch name can be revoked");
}

#[tokio::test(flavor = "current_thread")]
async fn deadline_and_cancellation_release_the_pipe_name() {
    let deadline_name = endpoint_name("deadline-release");
    let endpoint =
        WindowsProtectedEndpoint::bind(&deadline_name, capacity()).expect("deadline server");
    let expected = ExpectedLocalPeer::new(std::process::id()).expect("current PID");
    let (_cancel_handle, mut cancellation) = endpoint_cancellation();
    let failure = endpoint
        .accept(expected, Instant::now(), &mut cancellation)
        .await
        .expect_err("expired deadline");
    let error = drive_cleanup(failure).await;
    assert!(matches!(error, ProtectedEndpointError::DeadlineElapsed));
    WindowsProtectedEndpoint::bind(&deadline_name, capacity())
        .expect("deadline revoked the instance")
        .revoke(Instant::now() + Duration::from_secs(1))
        .await
        .expect("deadline name can be revoked");

    let cancel_name = endpoint_name("cancel-release");
    let endpoint = WindowsProtectedEndpoint::bind(&cancel_name, capacity()).expect("cancel server");
    let (cancel_handle, mut cancellation) = endpoint_cancellation();
    cancel_handle.cancel();
    let failure = endpoint
        .accept(
            expected,
            Instant::now() + Duration::from_secs(1),
            &mut cancellation,
        )
        .await
        .expect_err("cancelled accept");
    let error = drive_cleanup(failure).await;
    assert!(matches!(error, ProtectedEndpointError::Cancelled));
    WindowsProtectedEndpoint::bind(&cancel_name, capacity())
        .expect("cancel revoked the instance")
        .revoke(Instant::now() + Duration::from_secs(1))
        .await
        .expect("cancel name can be revoked");
}

#[tokio::test(flavor = "current_thread")]
async fn client_rejects_unexpected_server_pid_before_io() {
    let endpoint = WindowsProtectedEndpoint::bind(&endpoint_name("wrong-server"), capacity())
        .expect("protected server");
    let wrong_pid = std::process::id().checked_add(1).expect("test PID");
    let expected = ExpectedLocalPeer::new(wrong_pid).expect("nonzero PID");

    let error = WindowsProtectedEndpoint::connect(endpoint.address(), expected)
        .expect_err("client must reject the wrong server");
    assert!(matches!(
        error,
        ProtectedEndpointError::PeerMismatch {
            expected_process_id,
            actual_process_id: Some(actual),
        } if expected_process_id == wrong_pid && actual == std::process::id()
    ));
    endpoint
        .revoke(Instant::now() + Duration::from_secs(1))
        .await
        .expect("failed client verification leaves a revocable endpoint");
}
