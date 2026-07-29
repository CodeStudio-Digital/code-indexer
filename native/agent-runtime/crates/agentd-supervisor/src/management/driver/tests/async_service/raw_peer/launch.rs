use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use agent_protocol::generated::v1 as wire;

use super::super::super::fakes::{ContainmentState, FakeProvisioner};
use super::super::fixtures::{empty_core_with, service};
use super::{RawHost, TestService, raw_pair};
use crate::management::{
    SupervisorAsyncServiceAdvance, SupervisorAsyncServiceStatus, SupervisorDriverStep,
};

async fn fresh_service(
    capacity: usize,
    provisioner: FakeProvisioner,
) -> (
    RawHost,
    Arc<ContainmentState>,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
    TestService,
) {
    let prepare_calls = Arc::clone(&provisioner.calls);
    let complete_calls = Arc::clone(&provisioner.complete_calls);
    let (core, containment) = empty_core_with(provisioner);
    let (host, actor) = raw_pair(capacity).await;
    let (_shutdown, service) = service(actor, core);
    (host, containment, prepare_calls, complete_calls, service)
}

#[tokio::test]
async fn fresh_launch_is_cancel_safe_and_completes_the_fact_chain() {
    let (mut host, containment, prepare_calls, complete_calls, mut service) =
        fresh_service(1, FakeProvisioner::successful()).await;

    let ((), blocked) = tokio::join!(
        host.send_launch(),
        tokio::time::timeout(Duration::from_millis(100), service.advance())
    );
    assert!(blocked.is_err(), "tiny peer must hold LaunchAccepted");
    assert!(service.has_pending_write());
    assert_eq!(service.owner().pending_management_facts(), 0);
    assert_eq!(containment.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(prepare_calls.load(Ordering::SeqCst), 1);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 1);

    let (accepted, resumed) = tokio::join!(host.receive(), service.advance());
    assert!(matches!(
        resumed,
        SupervisorAsyncServiceAdvance::LaunchResolved(SupervisorDriverStep::LaunchAccepted {
            reused_existing: false
        })
    ));
    assert!(matches!(
        accepted.body,
        wire::management_payload::Body::LaunchAccepted(_)
    ));
    assert_eq!(service.owner().pending_management_facts(), 1);

    let host_exchange = async {
        host.acknowledge(&accepted).await;
        host.receive().await
    };
    let (spawned, advanced) = tokio::join!(host_exchange, service.advance());
    assert!(matches!(
        advanced,
        SupervisorAsyncServiceAdvance::ManagementAcknowledged
    ));
    assert!(matches!(
        spawned.body,
        wire::management_payload::Body::AttemptProcessSpawned(_)
    ));

    let host_exchange = async {
        host.acknowledge(&spawned).await;
        host.receive().await
    };
    let (containment_fact, advanced) = tokio::join!(host_exchange, service.advance());
    assert!(matches!(
        advanced,
        SupervisorAsyncServiceAdvance::ManagementAcknowledged
    ));
    assert!(matches!(
        containment_fact.body,
        wire::management_payload::Body::AttemptContainmentReport(_)
    ));

    let ((), advanced) = tokio::join!(host.acknowledge(&containment_fact), service.advance());
    assert!(matches!(
        advanced,
        SupervisorAsyncServiceAdvance::ManagementAcknowledged
    ));
    assert_eq!(service.owner().pending_management_facts(), 0);
    assert_eq!(service.status(), SupervisorAsyncServiceStatus::Online);
}

#[tokio::test]
async fn semantic_launch_retry_never_respawns_or_reprovisions() {
    let (mut host, containment, prepare_calls, complete_calls, mut service) =
        fresh_service(256 * 1024, FakeProvisioner::successful()).await;

    host.send_launch().await;
    let (first, first_step) = tokio::join!(host.receive(), service.advance());
    assert!(matches!(
        first_step,
        SupervisorAsyncServiceAdvance::LaunchResolved(SupervisorDriverStep::LaunchAccepted {
            reused_existing: false
        })
    ));
    assert!(matches!(
        first.body,
        wire::management_payload::Body::LaunchAccepted(_)
    ));

    host.send_launch().await;
    let (second, second_step) = tokio::join!(host.receive(), service.advance());
    assert!(matches!(
        second_step,
        SupervisorAsyncServiceAdvance::LaunchResolved(SupervisorDriverStep::LaunchAccepted {
            reused_existing: true
        })
    ));
    assert!(matches!(
        second.body,
        wire::management_payload::Body::LaunchAccepted(_)
    ));
    assert_ne!(first.message_id, second.message_id);
    assert_eq!(first.reply_to_message_id.as_deref(), Some("raw-host:2"));
    assert_eq!(second.reply_to_message_id.as_deref(), Some("raw-host:3"));
    assert_eq!(containment.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(prepare_calls.load(Ordering::SeqCst), 1);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 1);
    assert_eq!(service.owner().owned_attempts(), 1);
    assert_eq!(service.owner().pending_management_facts(), 2);

    host.acknowledge(&first).await;
    assert!(matches!(
        service.advance().await,
        SupervisorAsyncServiceAdvance::ManagementAcknowledged
    ));
    let spawned = host.receive().await;
    assert!(matches!(
        spawned.body,
        wire::management_payload::Body::AttemptProcessSpawned(_)
    ));
    assert_eq!(service.owner().pending_management_facts(), 2);

    host.acknowledge(&second).await;
    assert!(matches!(
        service.advance().await,
        SupervisorAsyncServiceAdvance::ManagementAcknowledged
    ));
    assert_eq!(service.owner().pending_management_facts(), 1);

    host.acknowledge(&spawned).await;
    assert!(matches!(
        service.advance().await,
        SupervisorAsyncServiceAdvance::ManagementAcknowledged
    ));
    let containment_fact = host.receive().await;
    assert!(matches!(
        containment_fact.body,
        wire::management_payload::Body::AttemptContainmentReport(_)
    ));

    host.acknowledge(&containment_fact).await;
    assert!(matches!(
        service.advance().await,
        SupervisorAsyncServiceAdvance::ManagementAcknowledged
    ));
    assert_eq!(service.owner().pending_management_facts(), 0);
}

#[tokio::test]
async fn exact_transport_replay_reuses_the_physical_response_without_effects() {
    let (mut host, containment, prepare_calls, complete_calls, mut service) =
        fresh_service(256 * 1024, FakeProvisioner::successful()).await;

    let sent = host.send_launch_recorded().await;
    let (accepted, first_step) = tokio::join!(host.receive(), service.advance());
    assert!(matches!(
        first_step,
        SupervisorAsyncServiceAdvance::LaunchResolved(SupervisorDriverStep::LaunchAccepted {
            reused_existing: false
        })
    ));

    host.replay(&sent).await;
    let (replayed, replay_step) = tokio::join!(host.receive(), service.advance());
    assert!(matches!(replay_step, SupervisorAsyncServiceAdvance::Replay));
    assert_eq!(replayed.encoded, accepted.encoded);
    assert_eq!(containment.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(prepare_calls.load(Ordering::SeqCst), 1);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 1);
    assert_eq!(service.owner().pending_management_facts(), 1);
}

#[tokio::test]
async fn failed_provision_emits_a_correlated_rejection_until_ack() {
    let (mut host, containment, prepare_calls, complete_calls, mut service) =
        fresh_service(256 * 1024, FakeProvisioner::failing()).await;

    host.send_launch().await;
    let (rejected, step) = tokio::join!(host.receive(), service.advance());
    assert!(matches!(
        step,
        SupervisorAsyncServiceAdvance::LaunchResolved(SupervisorDriverStep::LaunchRejected {
            reason_code: "SUPERVISOR_PROTECTED_HANDOFF_UNAVAILABLE"
        })
    ));
    let wire::management_payload::Body::LaunchRejected(rejection) = &rejected.body else {
        panic!("failed provision must emit LaunchRejected");
    };
    assert_eq!(
        rejection.reason_code,
        "SUPERVISOR_PROTECTED_HANDOFF_UNAVAILABLE"
    );
    assert_eq!(containment.spawn_calls.load(Ordering::SeqCst), 0);
    assert_eq!(prepare_calls.load(Ordering::SeqCst), 1);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 0);
    assert_eq!(service.owner().owned_attempts(), 0);
    assert_eq!(service.owner().pending_management_facts(), 1);

    let ((), advanced) = tokio::join!(host.acknowledge(&rejected), service.advance());
    assert!(matches!(
        advanced,
        SupervisorAsyncServiceAdvance::ManagementAcknowledged
    ));
    assert_eq!(service.owner().pending_management_facts(), 0);
    assert_eq!(service.status(), SupervisorAsyncServiceStatus::Online);
}

#[tokio::test]
async fn accepted_write_failure_closes_admission_and_retains_the_owner() {
    let (mut host, containment, prepare_calls, complete_calls, mut service) =
        fresh_service(256 * 1024, FakeProvisioner::successful()).await;
    host.send_launch().await;
    drop(host);

    let outcome = service.advance().await;
    assert!(
        matches!(outcome, SupervisorAsyncServiceAdvance::ChannelDraining(_)),
        "unexpected write-failure outcome: {outcome:?}"
    );
    assert_eq!(service.status(), SupervisorAsyncServiceStatus::Draining);
    assert!(!service.owner().state().is_accepting_launches());
    assert_eq!(containment.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(containment.terminate_calls.load(Ordering::SeqCst), 1);
    assert_eq!(prepare_calls.load(Ordering::SeqCst), 1);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 1);
    assert_eq!(service.owner().owned_attempts(), 1);
    assert_eq!(service.owner().pending_management_facts(), 0);
}
