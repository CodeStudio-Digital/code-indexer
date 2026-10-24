use std::sync::atomic::Ordering;
use std::time::Duration;

use agent_protocol::generated::v1 as wire;

use super::super::super::plan::LaunchPlan;
use super::super::fakes::ManualLifecycleClock;
use super::super::support::launch_attempt;
use super::fixtures::{empty_core, service};
use super::raw_peer::{
    fact_bound_parts, fact_bound_service, fact_bound_service_with_capacity, raw_pair,
};
use crate::management::{
    SupervisorAsyncService, SupervisorAsyncServiceAdvance, SupervisorAsyncServiceStatus,
    TokioSupervisorLifecycleTimer,
};
use crate::process_table::{OwnershipKey, reaped_attempt_for_test};

#[tokio::test]
async fn async_renewal_ack_commits_the_new_watchdog_without_another_process() {
    let (mut host, accepted, containment, mut service) = fact_bound_service().await;
    host.acknowledge(&accepted).await;
    service.advance().await;
    let spawned = host.receive().await;
    host.acknowledge(&spawned).await;
    service.advance().await;
    let report = host.receive().await;
    host.acknowledge(&report).await;
    service.advance().await;
    let expiry = host.renew_authority().await;
    assert!(matches!(
        service.advance().await,
        SupervisorAsyncServiceAdvance::AuthorityUpdated(
            crate::management::SupervisorDriverStep::AuthorityUpdated {
                reused_existing: false
            }
        )
    ));
    assert!(matches!(
        host.receive().await.body,
        wire::management_payload::Body::ManagementAck(_)
    ));
    assert_eq!(
        service.owner().next_physical_deadline_unix_ms(),
        Some(expiry)
    );
    assert_eq!(containment.spawn_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn staged_physical_exit_is_sent_before_reaped_and_each_waits_for_host_ack() {
    let mut core = empty_core();
    let plan = LaunchPlan::from_validated(&launch_attempt(), [8; 32]).expect("plan");
    let reaped = reaped_attempt_for_test(plan.metadata(), 32 * 1024 * 1024);
    let key = OwnershipKey::from_metadata(reaped.metadata());
    assert!(core.stage_reaped_lifecycle(&key, &reaped, wire::PhysicalExitCause::Fenced, 2_100,));
    let (mut host, actor) = raw_pair(256 * 1024).await;
    let (_shutdown, mut service) = service(actor, core);

    assert!(matches!(
        service.advance().await,
        SupervisorAsyncServiceAdvance::ManagementAcknowledged
    ));
    let exited = host.receive().await;
    assert!(matches!(
        exited.body,
        wire::management_payload::Body::AttemptProcessExited(_)
    ));
    assert_eq!(service.owner().pending_management_facts(), 1);

    host.acknowledge(&exited).await;
    assert!(matches!(
        service.advance().await,
        SupervisorAsyncServiceAdvance::ManagementAcknowledged
    ));
    let reaped = host.receive().await;
    assert!(matches!(
        reaped.body,
        wire::management_payload::Body::AttemptProcessReaped(_)
    ));
    assert_eq!(service.owner().pending_management_facts(), 1);

    host.acknowledge(&reaped).await;
    assert!(matches!(
        service.advance().await,
        SupervisorAsyncServiceAdvance::ManagementAcknowledged
    ));
    assert_eq!(service.owner().pending_management_facts(), 0);
}

#[tokio::test]
async fn async_ack_advances_each_fact_and_tracks_its_physical_receipt() {
    let (mut host, accepted, containment, mut service) = fact_bound_service().await;
    assert_eq!(service.owner().pending_management_facts(), 1);

    host.acknowledge(&accepted).await;
    assert!(matches!(
        service.advance().await,
        SupervisorAsyncServiceAdvance::ManagementAcknowledged
    ));
    let spawned = host.receive().await;
    assert!(matches!(
        spawned.body,
        wire::management_payload::Body::AttemptProcessSpawned(_)
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
    assert_eq!(service.owner().pending_management_facts(), 1);

    host.acknowledge(&containment_fact).await;
    assert!(matches!(
        service.advance().await,
        SupervisorAsyncServiceAdvance::ManagementAcknowledged
    ));
    assert_eq!(service.owner().pending_management_facts(), 0);
    assert_eq!(service.status(), SupervisorAsyncServiceStatus::Online);
    assert_eq!(containment.spawn_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cancelled_after_enqueue_resumes_fact_tracking_before_the_next_ack() {
    let (mut host, accepted, _, mut service) = fact_bound_service_with_capacity(1).await;

    let ((), cancelled) = tokio::join!(
        host.acknowledge(&accepted),
        tokio::time::timeout(Duration::from_millis(100), service.advance())
    );
    assert!(cancelled.is_err(), "tiny peer must hold the fact write");
    assert!(service.has_pending_write());
    assert_eq!(service.owner().pending_management_facts(), 0);

    let (spawned, resumed) = tokio::join!(host.receive(), service.advance());
    assert!(matches!(
        resumed,
        SupervisorAsyncServiceAdvance::ManagementAcknowledged
    ));
    assert!(!service.has_pending_write());
    assert_eq!(service.owner().pending_management_facts(), 1);

    let host_exchange = async {
        host.acknowledge(&spawned).await;
        host.receive().await
    };
    let (containment, next_ack) = tokio::join!(host_exchange, service.advance());
    assert!(matches!(
        next_ack,
        SupervisorAsyncServiceAdvance::ManagementAcknowledged
    ));
    assert!(matches!(
        containment.body,
        wire::management_payload::Body::AttemptContainmentReport(_)
    ));
    assert_eq!(service.owner().pending_management_facts(), 1);
}

#[tokio::test]
async fn watchdog_keeps_advancing_while_a_fact_write_is_blocked() {
    let (mut host, accepted, containment, core, actor) = fact_bound_parts(1).await;
    let deadline = core
        .state()
        .next_cleanup_deadline_unix_ms()
        .expect("authority watchdog");
    let clock = ManualLifecycleClock::new(deadline - 1_000);
    let clock_control = clock.clone();
    let (_shutdown, mut service) =
        SupervisorAsyncService::new(actor, core, clock, TokioSupervisorLifecycleTimer);

    let ((), blocked) = tokio::join!(
        host.acknowledge(&accepted),
        tokio::time::timeout(Duration::from_millis(100), service.advance())
    );
    assert!(
        blocked.is_err(),
        "tiny peer must hold the fact write, got {blocked:?}"
    );
    assert!(service.has_pending_write());

    clock_control.set(deadline);
    assert!(
        tokio::time::timeout(Duration::from_millis(20), service.advance())
            .await
            .is_err(),
        "write remains blocked after the watchdog tick"
    );
    assert_eq!(containment.terminate_calls.load(Ordering::SeqCst), 1);

    let (spawned, resumed) = tokio::join!(host.receive(), service.advance());
    assert!(matches!(
        resumed,
        SupervisorAsyncServiceAdvance::ManagementAcknowledged
    ));
    assert!(matches!(
        spawned.body,
        wire::management_payload::Body::AttemptProcessSpawned(_)
    ));
    assert_eq!(service.owner().pending_management_facts(), 1);
}
