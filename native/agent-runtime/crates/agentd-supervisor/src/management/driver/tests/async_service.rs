use std::time::Duration;

use self::fixtures::{
    FixedClock, assert_acknowledged, async_pair, empty_core, fence_command, launched_core, service,
};
use crate::management::{
    OnlineLifecycleShutdown, SupervisorAsyncService, SupervisorAsyncServiceAdvance,
    SupervisorAsyncServiceOutcome, SupervisorAsyncServiceStatus, SupervisorDriverStep,
    SupervisorManagementTerminal, TokioSupervisorLifecycleTimer,
};

mod ack_progression;
mod fixtures;
mod raw_peer;
mod shutdown;
mod terminal_behaviour;

#[tokio::test]
async fn target_schedule_precedes_each_async_ack_and_semantic_retry_is_idempotent() {
    let (core, _) = launched_core();
    let (mut host, supervisor) = async_pair().await;
    let (_shutdown, mut service) = service(supervisor, core);
    let command = fence_command();

    host.command_port()
        .send(command.clone())
        .await
        .expect("fence physically written");
    assert!(matches!(
        service.advance().await,
        SupervisorAsyncServiceAdvance::TerminationScheduled(SupervisorDriverStep::FenceScheduled {
            reused_existing: false
        })
    ));
    assert!(service.owner().state().is_accepting_launches());
    assert_acknowledged(&mut host).await;

    host.command_port()
        .send(command)
        .await
        .expect("semantic retry physically written");
    assert!(matches!(
        service.advance().await,
        SupervisorAsyncServiceAdvance::TerminationScheduled(SupervisorDriverStep::FenceScheduled {
            reused_existing: true
        })
    ));
    assert_acknowledged(&mut host).await;
    assert_eq!(service.status(), SupervisorAsyncServiceStatus::Online);
}

#[tokio::test]
async fn cancelled_advance_keeps_actor_core_and_deadlines_owned() {
    let (core, _) = launched_core();
    let (mut host, supervisor) = async_pair().await;
    let (_shutdown, mut service) = service(supervisor, core);

    assert!(
        tokio::time::timeout(Duration::from_millis(2), service.advance())
            .await
            .is_err()
    );
    host.command_port()
        .send(fence_command())
        .await
        .expect("fence after cancelled poll");
    assert!(matches!(
        service.advance().await,
        SupervisorAsyncServiceAdvance::TerminationScheduled(_)
    ));
    assert_acknowledged(&mut host).await;
    assert_eq!(service.owner().owned_attempts(), 1);
}

#[tokio::test]
async fn watchdog_advances_without_any_management_frame() {
    let (core, containment) = launched_core();
    let (_host, supervisor) = async_pair().await;
    let clock = FixedClock(
        core.state()
            .next_cleanup_deadline_unix_ms()
            .expect("watchdog"),
    );
    let (_shutdown, mut service) =
        SupervisorAsyncService::new(supervisor, core, clock, TokioSupervisorLifecycleTimer);

    assert!(matches!(
        service.advance().await,
        SupervisorAsyncServiceAdvance::Cleanup(_)
    ));
    assert_eq!(
        containment
            .terminate_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
}

#[tokio::test]
async fn ack_write_failure_keeps_schedule_and_closes_global_admission() {
    let (core, _) = launched_core();
    let (host, supervisor) = async_pair().await;
    let port = host.command_port();
    let (_shutdown, mut service) = service(supervisor, core);
    port.send(fence_command())
        .await
        .expect("fence physically written");
    drop(port);
    drop(host);
    tokio::time::sleep(Duration::from_millis(10)).await;

    let outcome = service.advance().await;
    assert!(
        matches!(outcome, SupervisorAsyncServiceAdvance::ChannelDraining(_)),
        "unexpected service outcome: {outcome:?}"
    );
    assert_eq!(service.status(), SupervisorAsyncServiceStatus::Draining);
    assert!(!service.owner().state().is_accepting_launches());
    assert_eq!(service.owner().owned_attempts(), 1);
    assert_eq!(service.owner().state().pending_cleanup_count(), 1);
}

#[tokio::test]
async fn permanent_loop_returns_the_closed_core_after_an_idle_shutdown() {
    let core = empty_core();
    let (_host, supervisor) = async_pair().await;
    let (shutdown, service) = service(supervisor, core);
    shutdown
        .request(
            OnlineLifecycleShutdown::new(4_102_444_800_000)
                .expect("bounded future shutdown deadline"),
        )
        .expect("shutdown admission");

    let outcome = tokio::time::timeout(Duration::from_secs(1), service.run())
        .await
        .expect("permanent loop drain deadline");
    let SupervisorAsyncServiceOutcome::PhysicallyDrained { owner, terminal } = outcome else {
        panic!("idle shutdown must return the retained core");
    };
    assert_eq!(terminal, SupervisorManagementTerminal::Shutdown);
    assert!(!owner.state().is_accepting_launches());
    assert_eq!(owner.owned_attempts(), 0);
}
