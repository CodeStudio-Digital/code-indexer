use std::sync::atomic::Ordering;
use std::time::Duration;

use agent_protocol::generated::v1 as wire;
use agent_protocol::management_channel::AsyncManagementEvent;

use super::fixtures::{async_pair, launched_core, service};
use crate::management::{
    SupervisorAsyncServiceAdvance, SupervisorAsyncServiceStatus, SupervisorDriverError,
};

#[tokio::test]
async fn peer_eof_preserves_the_owned_attempt_and_enters_physical_drain() {
    let (core, containment) = launched_core();
    let (host, supervisor) = async_pair().await;
    let (_shutdown, mut service) = service(supervisor, core);
    drop(host);

    let outcome = tokio::time::timeout(Duration::from_secs(1), service.advance())
        .await
        .expect("EOF propagation deadline");
    assert!(
        matches!(outcome, SupervisorAsyncServiceAdvance::ChannelDraining(_)),
        "unexpected EOF outcome: {outcome:?}"
    );
    assert_eq!(service.status(), SupervisorAsyncServiceStatus::Draining);
    assert!(!service.owner().state().is_accepting_launches());
    assert_eq!(service.owner().owned_attempts(), 1);
    assert_eq!(service.owner().state().pending_cleanup_count(), 1);
    assert_eq!(containment.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(containment.terminate_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn unsupported_query_closes_admission_without_a_second_spawn_or_ack() {
    let (core, containment) = launched_core();
    let (mut host, supervisor) = async_pair().await;
    let (_shutdown, mut service) = service(supervisor, core);
    let query = wire::ManagementPayload {
        body: Some(wire::management_payload::Body::QuerySupervisorState(
            wire::QuerySupervisorState::default(),
        )),
    };
    host.command_port()
        .send(query)
        .await
        .expect("query physically written");

    let outcome = service.advance().await;
    assert!(matches!(
        outcome,
        SupervisorAsyncServiceAdvance::DriverFailure(SupervisorDriverError::UnsupportedInbound(
            "QuerySupervisorState"
        ))
    ));
    assert_eq!(service.status(), SupervisorAsyncServiceStatus::Draining);
    assert!(!service.owner().state().is_accepting_launches());
    assert_eq!(service.owner().owned_attempts(), 1);
    assert_eq!(service.owner().state().pending_cleanup_count(), 1);
    assert_eq!(containment.spawn_calls.load(Ordering::SeqCst), 1);

    let host_event = tokio::time::timeout(Duration::from_secs(1), host.receive())
        .await
        .expect("host closure deadline");
    assert!(
        !matches!(host_event, Some(Ok(AsyncManagementEvent::Acknowledged(_)))),
        "unsupported query must not receive an ACK"
    );
}
