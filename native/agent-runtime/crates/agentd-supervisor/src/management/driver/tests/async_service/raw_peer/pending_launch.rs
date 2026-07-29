use std::sync::atomic::Ordering;

use agent_protocol::generated::v1 as wire;

use super::raw_pair;
use crate::management::{
    SupervisorAsyncServiceAdvance, SupervisorAsyncServiceStatus, SupervisorDriverStep,
};

mod support;

use support::{
    ANTI_HANG, assert_effect_counts, empty_blocking_core, request_shutdown_at,
    resolve_pending_launch, sibling_core, system_service, wait_for_blocked_spawn,
};

#[tokio::test(flavor = "current_thread")]
async fn cancelled_advance_during_blocked_spawn_resumes_exactly_once() {
    let (core, containment, gate, prepares, completions) = empty_blocking_core();
    let (mut host, actor) = raw_pair(256 * 1024).await;
    let (_shutdown, mut service) = system_service(actor, core);
    host.send_launch().await;

    let mut advance = Box::pin(service.advance());
    tokio::select! {
        biased;
        entered = tokio::time::timeout(ANTI_HANG, gate.wait_until_entered()) => {
            entered.expect("physical spawn reached gate");
        }
        outcome = &mut advance => panic!("launch resolved before gate release: {outcome:?}"),
    }
    drop(advance);
    assert!(service.has_pending_launch());
    assert_eq!(gate.entries(), 1);
    assert_eq!(containment.spawn_calls.load(Ordering::SeqCst), 0);

    gate.release();
    let (accepted, outcome) = tokio::join!(host.receive(), service.advance());
    assert!(matches!(
        outcome,
        SupervisorAsyncServiceAdvance::LaunchResolved(SupervisorDriverStep::LaunchAccepted {
            reused_existing: false
        })
    ));
    assert!(matches!(
        accepted.body,
        wire::management_payload::Body::LaunchAccepted(_)
    ));
    assert!(!service.has_pending_launch());
    assert_effect_counts(&prepares, &completions, 1, 1);
    assert_eq!(containment.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(service.owner().owned_attempts(), 1);
    assert_eq!(service.owner().pending_management_facts(), 1);
    assert!(!gate.timed_out());
}

#[tokio::test(flavor = "current_thread")]
async fn sibling_watchdog_advances_while_a_new_spawn_is_blocked() {
    let (core, containment, gate, prepares, completions) = sibling_core();
    let (mut host, actor) = raw_pair(256 * 1024).await;
    let (_shutdown, mut service) = system_service(actor, core);
    host.send_launch().await;

    wait_for_blocked_spawn(&mut service, &gate).await;
    let outcome = tokio::time::timeout(ANTI_HANG, service.advance())
        .await
        .expect("sibling watchdog advanced while spawn stayed blocked");
    assert!(matches!(outcome, SupervisorAsyncServiceAdvance::Cleanup(_)));
    assert!(service.has_pending_launch());
    assert_eq!(containment.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(containment.terminate_calls.load(Ordering::SeqCst), 1);
    assert_effect_counts(&prepares, &completions, 2, 1);
    assert!(!gate.timed_out());

    gate.release();
    let outcome = resolve_pending_launch(&mut service).await;
    assert!(matches!(
        outcome,
        SupervisorAsyncServiceAdvance::LaunchResolved(SupervisorDriverStep::LaunchAccepted {
            reused_existing: false
        })
    ));
    let accepted = host.receive().await;
    assert!(matches!(
        accepted.body,
        wire::management_payload::Body::LaunchAccepted(_)
    ));
    assert!(!service.has_pending_launch());
    assert_eq!(containment.spawn_calls.load(Ordering::SeqCst), 2);
    assert_eq!(completions.load(Ordering::SeqCst), 2);
}

#[tokio::test(flavor = "current_thread")]
async fn shutdown_arms_during_blocked_spawn_and_waits_for_its_result() {
    let (core, containment, gate, prepares, completions) = empty_blocking_core();
    let (mut host, actor) = raw_pair(256 * 1024).await;
    let (shutdown, mut service) = system_service(actor, core);
    host.send_launch().await;

    wait_for_blocked_spawn(&mut service, &gate).await;
    request_shutdown_at(&shutdown, 4_102_444_800_000);
    let outcome = tokio::time::timeout(ANTI_HANG, service.advance())
        .await
        .expect("shutdown woke the blocked launch owner");
    assert!(matches!(
        outcome,
        SupervisorAsyncServiceAdvance::ShutdownArmed
    ));
    assert_eq!(service.status(), SupervisorAsyncServiceStatus::Draining);
    assert!(!service.owner().state().is_accepting_launches());
    assert!(service.has_pending_launch());

    let mut drain = Box::pin(service.advance());
    tokio::select! {
        biased;
        outcome = &mut drain => panic!("drained before physical result: {outcome:?}"),
        () = tokio::task::yield_now() => {}
    }
    drop(drain);
    assert!(service.has_pending_launch());

    gate.release();
    let outcome = resolve_pending_launch(&mut service).await;
    assert!(matches!(
        outcome,
        SupervisorAsyncServiceAdvance::LaunchResolved(SupervisorDriverStep::LaunchRejected { .. })
    ));
    let rejected = host.receive().await;
    assert!(matches!(
        rejected.body,
        wire::management_payload::Body::LaunchRejected(_)
    ));
    assert!(!service.has_pending_launch());
    assert_effect_counts(&prepares, &completions, 1, 0);
    assert_eq!(containment.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(containment.terminate_calls.load(Ordering::SeqCst), 1);
    assert_eq!(service.owner().owned_attempts(), 1);
    assert!(service.owner().state().pending_cleanup_count() > 0);
    assert!(!gate.timed_out());
}
