use agent_protocol::generated::v1 as wire;

use self::support::{send_and_ack, shutdown_command, wire_payload};
use super::fixtures::{assert_acknowledged, async_pair, launched_core, service};
use crate::management::{SupervisorAsyncServiceAdvance, SupervisorAsyncServiceStatus};

mod reliability;
mod support;

#[tokio::test]
async fn drain_closes_admission_without_shortening_attempt_grace() {
    let (core, containment) = launched_core();
    let attempt_deadline = core.state().test_next_attempt_cleanup_deadline_unix_ms();
    let (mut host, actor) = async_pair().await;
    let (_external_shutdown, mut service) = service(actor, core);
    let command = shutdown_command(
        wire::SupervisorShutdownMode::Drain,
        "shutdown:drain",
        120_000,
    );
    let drain_deadline = command.shutdown_deadline_at_unix_ms;

    host.command_port()
        .send(wire_payload(command))
        .await
        .expect("drain physically written");
    assert!(matches!(
        service.advance().await,
        SupervisorAsyncServiceAdvance::ShutdownArmed
    ));
    assert_eq!(service.status(), SupervisorAsyncServiceStatus::Draining);
    assert!(!service.owner().state().is_accepting_launches());
    assert_eq!(
        service
            .owner()
            .state()
            .test_next_attempt_cleanup_deadline_unix_ms(),
        attempt_deadline
    );
    assert_eq!(
        service.owner().state().next_cleanup_deadline_unix_ms(),
        Some(drain_deadline)
    );
    assert_eq!(
        containment
            .terminate_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    assert_acknowledged(&mut host).await;
}

#[tokio::test]
async fn terminate_after_grace_shortens_every_attempt_before_ack() {
    let (core, containment) = launched_core();
    let (mut host, actor) = async_pair().await;
    let (_external_shutdown, mut service) = service(actor, core);
    let command = shutdown_command(
        wire::SupervisorShutdownMode::TerminateAfterGrace,
        "shutdown:terminate",
        60_000,
    );
    let expected_deadline = command.shutdown_deadline_at_unix_ms;

    host.command_port()
        .send(wire_payload(command))
        .await
        .expect("termination shutdown physically written");
    assert!(matches!(
        service.advance().await,
        SupervisorAsyncServiceAdvance::ShutdownArmed
    ));
    assert_eq!(
        service
            .owner()
            .state()
            .test_next_attempt_cleanup_deadline_unix_ms(),
        Some(expected_deadline)
    );
    assert_eq!(
        containment
            .terminate_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    assert_acknowledged(&mut host).await;
}

#[tokio::test]
async fn semantic_retry_is_acknowledged_without_reapplying_shutdown() {
    let core = launched_core().0;
    let (mut host, actor) = async_pair().await;
    let (_external_shutdown, mut service) = service(actor, core);
    let command = shutdown_command(
        wire::SupervisorShutdownMode::TerminateAfterGrace,
        "shutdown:semantic-retry",
        60_000,
    );
    let expected_deadline = command.shutdown_deadline_at_unix_ms;

    host.command_port()
        .send(wire_payload(command.clone()))
        .await
        .expect("shutdown physically written");
    assert!(matches!(
        service.advance().await,
        SupervisorAsyncServiceAdvance::ShutdownArmed
    ));
    assert_acknowledged(&mut host).await;

    host.command_port()
        .send(wire_payload(command))
        .await
        .expect("semantic retry physically written");
    assert!(matches!(
        service.advance().await,
        SupervisorAsyncServiceAdvance::ShutdownArmed
    ));
    assert_acknowledged(&mut host).await;
    assert_eq!(
        service
            .owner()
            .state()
            .test_next_attempt_cleanup_deadline_unix_ms(),
        Some(expected_deadline)
    );
}

#[tokio::test]
async fn drain_escalates_to_termination_but_never_weakens_it() {
    let core = launched_core().0;
    let (mut host, actor) = async_pair().await;
    let (_external_shutdown, mut service) = service(actor, core);
    let drain = shutdown_command(
        wire::SupervisorShutdownMode::Drain,
        "shutdown:escalate-drain",
        120_000,
    );
    let terminate = shutdown_command(
        wire::SupervisorShutdownMode::TerminateAfterGrace,
        "shutdown:escalate-terminate",
        60_000,
    );
    let expected_deadline = terminate.shutdown_deadline_at_unix_ms;

    send_and_ack(&mut host, &mut service, drain).await;
    send_and_ack(&mut host, &mut service, terminate).await;
    assert_eq!(
        service
            .owner()
            .state()
            .test_next_attempt_cleanup_deadline_unix_ms(),
        Some(expected_deadline)
    );
}

#[tokio::test]
async fn later_drain_is_subsumed_by_an_existing_termination() {
    let core = launched_core().0;
    let (mut host, actor) = async_pair().await;
    let (_external_shutdown, mut service) = service(actor, core);
    let terminate = shutdown_command(
        wire::SupervisorShutdownMode::TerminateAfterGrace,
        "shutdown:strong-first",
        90_000,
    );
    let expected_deadline = terminate.shutdown_deadline_at_unix_ms;
    let drain = shutdown_command(
        wire::SupervisorShutdownMode::Drain,
        "shutdown:weak-second",
        30_000,
    );

    send_and_ack(&mut host, &mut service, terminate).await;
    send_and_ack(&mut host, &mut service, drain).await;
    assert_eq!(
        service.owner().state().next_cleanup_deadline_unix_ms(),
        Some(expected_deadline)
    );
}
