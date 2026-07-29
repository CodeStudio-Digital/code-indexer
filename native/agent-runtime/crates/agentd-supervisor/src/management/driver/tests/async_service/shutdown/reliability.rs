use std::time::Duration;

use agent_protocol::generated::v1 as wire;

use super::super::super::fakes::ManualLifecycleClock;
use super::super::fixtures::{async_pair, empty_core, launched_core, service};
use super::super::raw_peer::raw_pair;
use super::support::{assert_clean_shutdown, send_and_ack, shutdown_command, wire_payload};
use crate::management::{
    CleanupStateError, SupervisorAsyncService, SupervisorAsyncServiceAdvance,
    SupervisorAsyncServiceStatus, SupervisorDriverError, TokioSupervisorLifecycleTimer,
};

#[tokio::test]
async fn cancelled_ack_write_retains_the_committed_shutdown() {
    let (mut host, actor) = raw_pair(1).await;
    let (_external_shutdown, mut service) = service(actor, empty_core());
    let command = shutdown_command(
        wire::SupervisorShutdownMode::TerminateAfterGrace,
        "shutdown:cancel-safe",
        60_000,
    );

    let ((), blocked) = tokio::join!(
        host.send_shutdown(command),
        tokio::time::timeout(Duration::from_millis(100), service.advance())
    );
    assert!(blocked.is_err(), "tiny peer must hold the shutdown ACK");
    assert!(service.has_pending_write());
    assert_eq!(service.status(), SupervisorAsyncServiceStatus::Draining);
    assert!(!service.owner().state().is_accepting_launches());

    let (ack, resumed) = tokio::join!(host.receive(), service.advance());
    assert!(matches!(
        resumed,
        SupervisorAsyncServiceAdvance::ShutdownArmed
    ));
    assert!(matches!(
        ack.body,
        wire::management_payload::Body::ManagementAck(_)
    ));
    assert!(!service.has_pending_write());
    assert_clean_shutdown(service).await;
}

#[tokio::test]
async fn ack_write_failure_keeps_shutdown_closed_and_owned() {
    let (core, containment) = launched_core();
    let (host, actor) = async_pair().await;
    let port = host.command_port();
    let (_external_shutdown, mut service) = service(actor, core);
    port.send(wire_payload(shutdown_command(
        wire::SupervisorShutdownMode::Drain,
        "shutdown:write-failure",
        60_000,
    )))
    .await
    .expect("shutdown physically written");
    drop(port);
    drop(host);
    tokio::time::sleep(Duration::from_millis(10)).await;

    let outcome = service.advance().await;
    assert!(
        matches!(outcome, SupervisorAsyncServiceAdvance::ChannelDraining(_)),
        "unexpected shutdown write outcome: {outcome:?}"
    );
    assert_eq!(service.status(), SupervisorAsyncServiceStatus::Draining);
    assert!(!service.owner().state().is_accepting_launches());
    assert_eq!(service.owner().owned_attempts(), 1);
    assert_eq!(service.owner().state().pending_cleanup_count(), 1);
    assert_eq!(
        containment
            .terminate_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
}

#[tokio::test]
async fn exact_transport_replay_reuses_the_shutdown_ack() {
    let (mut host, actor) = raw_pair(256 * 1024).await;
    let (_external_shutdown, mut service) = service(actor, empty_core());
    let sent = host
        .send_shutdown_recorded(shutdown_command(
            wire::SupervisorShutdownMode::Drain,
            "shutdown:transport-replay",
            60_000,
        ))
        .await;

    let (ack, first_step) = tokio::join!(host.receive(), service.advance());
    assert!(matches!(
        first_step,
        SupervisorAsyncServiceAdvance::ShutdownArmed
    ));
    host.replay(&sent).await;
    let (replayed, replay_step) = tokio::join!(host.receive(), service.advance());
    assert!(matches!(replay_step, SupervisorAsyncServiceAdvance::Replay));
    assert_eq!(replayed.encoded, ack.encoded);
}

#[tokio::test]
async fn conflicting_idempotency_key_fails_closed() {
    let core = launched_core().0;
    let (mut host, actor) = async_pair().await;
    let (_external_shutdown, mut service) = service(actor, core);
    let first = shutdown_command(
        wire::SupervisorShutdownMode::Drain,
        "shutdown:conflict",
        120_000,
    );
    let conflicting = shutdown_command(
        wire::SupervisorShutdownMode::Drain,
        "shutdown:conflict",
        60_000,
    );

    send_and_ack(&mut host, &mut service, first).await;
    host.command_port()
        .send(wire_payload(conflicting))
        .await
        .expect("conflicting retry physically written");
    let outcome = service.advance().await;
    assert!(matches!(
        outcome,
        SupervisorAsyncServiceAdvance::DriverFailure(SupervisorDriverError::ShutdownConflict)
    ));
    assert_eq!(service.status(), SupervisorAsyncServiceStatus::Draining);
    assert!(!service.owner().state().is_accepting_launches());
}

#[tokio::test]
async fn deadline_reached_before_dispatch_fails_before_shutdown_mutation() {
    let core = launched_core().0;
    let (host, actor) = async_pair().await;
    let command = shutdown_command(
        wire::SupervisorShutdownMode::TerminateAfterGrace,
        "shutdown:expired-before-dispatch",
        60_000,
    );
    let expired_at = command.shutdown_deadline_at_unix_ms;
    let (_external_shutdown, mut service) = SupervisorAsyncService::new(
        actor,
        core,
        ManualLifecycleClock::new(expired_at),
        TokioSupervisorLifecycleTimer,
    );

    host.command_port()
        .send(wire_payload(command))
        .await
        .expect("shutdown physically written");
    let outcome = service.advance().await;
    assert!(matches!(
        outcome,
        SupervisorAsyncServiceAdvance::DriverFailure(SupervisorDriverError::CleanupState(
            CleanupStateError::CleanupDeadlineElapsed
        ))
    ));
    assert_eq!(
        service.status(),
        SupervisorAsyncServiceStatus::HardRestartRequired
    );
    assert_ne!(
        service
            .owner()
            .state()
            .test_next_attempt_cleanup_deadline_unix_ms(),
        Some(expired_at),
        "expired command must not install its shutdown deadline"
    );
}
