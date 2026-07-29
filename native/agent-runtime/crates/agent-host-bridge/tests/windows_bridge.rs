#![cfg(windows)]

mod support;

use std::time::Duration;

use agent_host_bridge::{AuthenticatedHostAttemptChannels, HostBridgeError, HostEndpointKind};
use agent_platform::ipc::{ExpectedLocalPeer, ProtectedEndpointFailure, endpoint_cancellation};
use tokio::time::Instant;

use support::BridgeFixture;

#[tokio::test]
async fn opens_control_and_data_as_one_durably_bound_native_owner() {
    let fixture = BridgeFixture::new();
    let owner = AuthenticatedHostAttemptChannels::open(fixture.encoded()).expect("native owner");
    assert_eq!(owner.binding().runner_pid(), std::process::id());
    assert_eq!(owner.binding().reservation_id(), "reservation-0001");
    assert_eq!(owner.binding().resource_group_id(), "resource-group-0001");
    assert_eq!(
        owner.binding().runtime_instance_id(),
        "runtime-instance-0001"
    );

    let (control, data) = owner.into_channels();
    assert_eq!(control.binding().peer_pid(), std::process::id());
    assert_eq!(control.binding().endpoint_id(), "control-endpoint-0001");
    assert_eq!(data.binding().peer_pid(), std::process::id());
    assert_eq!(data.binding().endpoint_id(), "data-endpoint-0001");
    let control_client = control.into_verified_stream();
    let data_client = data.into_verified_stream();

    let expected = ExpectedLocalPeer::new(std::process::id()).expect("current process");
    let (_control_cancel_handle, mut control_cancel) = endpoint_cancellation();
    let control_server = fixture
        .control
        .accept(
            expected,
            Instant::now() + Duration::from_secs(1),
            &mut control_cancel,
        )
        .await
        .expect("same control connection");
    let (_data_cancel_handle, mut data_cancel) = endpoint_cancellation();
    let data_server = fixture
        .data
        .accept(
            expected,
            Instant::now() + Duration::from_secs(1),
            &mut data_cancel,
        )
        .await
        .expect("same data connection");
    assert_eq!(control_server.peer().process_id(), std::process::id());
    assert_eq!(data_server.peer().process_id(), std::process::id());

    drop((control_client, data_client, control_server, data_server));
    fixture
        .pulse
        .revoke(Instant::now() + Duration::from_secs(1))
        .await
        .expect("unused pulse revoked");
}

#[tokio::test]
async fn durable_fact_divergence_fails_before_opening_any_endpoint() {
    let mut fixture = BridgeFixture::new();
    fixture
        .request
        .spawned
        .as_mut()
        .expect("spawned")
        .reservation_id = "reservation-divergent".into();

    let error = AuthenticatedHostAttemptChannels::open(fixture.encoded()).expect_err("divergence");
    assert!(matches!(
        error,
        HostBridgeError::InvalidRequest("durable_facts")
    ));
    revoke_all(fixture).await;
}

#[tokio::test]
async fn live_named_pipe_rejects_a_forged_expected_runner_pid() {
    let mut fixture = BridgeFixture::new();
    fixture
        .request
        .spawned
        .as_mut()
        .and_then(|value| value.runner_provenance.as_mut())
        .expect("runner provenance")
        .pid = std::process::id().saturating_add(1);

    let error =
        AuthenticatedHostAttemptChannels::open(fixture.encoded()).expect_err("PID mismatch");
    assert!(matches!(
        error,
        HostBridgeError::Endpoint {
            kind: HostEndpointKind::Control,
            ..
        }
    ));
    revoke_all(fixture).await;
}

async fn revoke_all(fixture: BridgeFixture) {
    for endpoint in [fixture.control, fixture.data, fixture.pulse] {
        match endpoint
            .revoke(Instant::now() + Duration::from_secs(1))
            .await
        {
            Ok(()) | Err(ProtectedEndpointFailure::Clean(_)) => {}
            Err(ProtectedEndpointFailure::Owned { error, .. }) => {
                panic!("endpoint cleanup retained ownership: {error}");
            }
        }
    }
}
