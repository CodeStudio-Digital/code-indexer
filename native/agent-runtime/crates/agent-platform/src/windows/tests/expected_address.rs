use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::Instant;

use crate::ipc::{
    EndpointBufferCapacity, ExpectedLocalPeer, ProtectedEndpointError, endpoint_cancellation,
};

use super::super::ipc::WindowsProtectedEndpoint;

const PIPE_PREFIX: &str = r"\\.\pipe\codestudio-agent-v1-";
static NEXT_ENDPOINT: AtomicU64 = AtomicU64::new(1);

fn expected_address(label: &str) -> String {
    format!(
        "{PIPE_PREFIX}{label}-{:08x}-{:016x}",
        std::process::id(),
        NEXT_ENDPOINT.fetch_add(1, Ordering::Relaxed)
    )
}

fn capacity() -> EndpointBufferCapacity {
    EndpointBufferCapacity::new(64 * 1_024).expect("bounded pipe buffer")
}

#[tokio::test(flavor = "current_thread")]
async fn exact_expected_address_binds_and_reports_the_real_creator_pid() {
    let address = expected_address("expected-address");
    let endpoint = WindowsProtectedEndpoint::bind_expected_address(&address, capacity())
        .expect("exact canonical address");
    assert_eq!(endpoint.address().as_str(), address);

    let expected = ExpectedLocalPeer::new(std::process::id()).expect("current PID");
    let mut client = WindowsProtectedEndpoint::connect_expected_address(&address, expected)
        .expect("verified endpoint creator");
    let (_cancel_handle, mut cancellation) = endpoint_cancellation();
    let mut server = endpoint
        .accept(
            expected,
            Instant::now() + Duration::from_secs(1),
            &mut cancellation,
        )
        .await
        .expect("verified endpoint client");

    client.write_all(b"ping").await.expect("client write");
    let mut received = [0_u8; 4];
    server.read_exact(&mut received).await.expect("server read");

    assert_eq!(received, *b"ping");
    assert_eq!(client.peer().process_id(), std::process::id());
    assert_eq!(server.peer().process_id(), std::process::id());
}

#[test]
fn expected_address_rejects_prefix_case_traversal_and_namespace_aliases() {
    let suffix = "invalid-address-00000000-0000000000000001";
    let invalid = [
        format!(r"\\.\pipe\other-{suffix}"),
        format!(r"\\.\PIPE\codestudio-agent-v1-{suffix}"),
        format!(r"{PIPE_PREFIX}..\..\{suffix}"),
        format!(r"\\?\pipe\codestudio-agent-v1-{suffix}"),
        format!(r"\\localhost\pipe\codestudio-agent-v1-{suffix}"),
        format!(r"{PIPE_PREFIX}Invalid-address-00000000-0000000000000001"),
    ];
    let expected = ExpectedLocalPeer::new(std::process::id()).expect("current PID");

    for address in invalid {
        assert!(matches!(
            WindowsProtectedEndpoint::bind_expected_address(&address, capacity()),
            Err(ProtectedEndpointError::InvalidAddress(_))
        ));
        assert!(matches!(
            WindowsProtectedEndpoint::connect_expected_address(&address, expected),
            Err(ProtectedEndpointError::InvalidAddress(_))
        ));
    }
}
