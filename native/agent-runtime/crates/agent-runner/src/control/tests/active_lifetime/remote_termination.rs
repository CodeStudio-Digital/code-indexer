use std::sync::atomic::Ordering;

use agent_platform::ipc::endpoint_cancellation;
use agent_protocol::generated::v1 as wire;

use super::support::{active, assert_revoked};
use crate::control::active_lifetime::{ActiveRunnerExitReason, ActiveRunnerLifetimeAdvance};
use crate::control::tests::support::{FENCED_AT, ManualClock, cancel_frame, fence_frame};
use crate::control::{AsyncControlDriverError, CancelOutcome, FenceOutcome};
use crate::lifecycle::RunnerState;

#[tokio::test]
async fn remote_cancel_returns_typed_cleanup_owner() {
    let clock = ManualClock::new(1_000);
    let (lifetime, _, gate, drops) = active([cancel_frame("cancel-active", 4)], clock, None).await;
    let token = gate.token().expect("active token");
    let (_handle, mut cancellation) = endpoint_cancellation();

    let ActiveRunnerLifetimeAdvance::CleanupRequired(cleanup) =
        lifetime.advance(&mut cancellation).await
    else {
        panic!("remote cancellation cannot continue");
    };

    let ActiveRunnerExitReason::RemoteCancelled(CancelOutcome::Accepted(cancelled)) =
        cleanup.reason()
    else {
        panic!("expected typed remote cancellation");
    };
    assert_eq!(cancelled.reason(), wire::CancelReason::UserRequest);
    assert_eq!(cancelled.reason_code(), "user_request");
    assert_eq!(cleanup.final_state(), RunnerState::Exiting);
    assert_revoked(&gate, &token);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    cleanup.close_local();
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn remote_fence_returns_typed_cleanup_owner() {
    let clock = ManualClock::new(1_000);
    let (lifetime, _, gate, drops) = active([fence_frame("fence-active", 4)], clock, None).await;
    let token = gate.token().expect("active token");
    let (_handle, mut cancellation) = endpoint_cancellation();

    let ActiveRunnerLifetimeAdvance::CleanupRequired(cleanup) =
        lifetime.advance(&mut cancellation).await
    else {
        panic!("remote fence cannot continue");
    };

    let ActiveRunnerExitReason::Fenced(FenceOutcome::Accepted(fenced)) = cleanup.reason() else {
        panic!("expected typed remote fence");
    };
    assert_eq!(fenced.replacement_fencing_epoch(), 8);
    assert_eq!(fenced.fenced_at_unix_ms(), FENCED_AT);
    assert_eq!(cleanup.final_state(), RunnerState::Exiting);
    assert_revoked(&gate, &token);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    cleanup.close_local();
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn preexisting_local_cancel_wins_over_ready_remote_cancel() {
    let clock = ManualClock::new(1_000);
    let (lifetime, _, gate, drops) = active([cancel_frame("cancel-ready", 4)], clock, None).await;
    let token = gate.token().expect("active token");
    let (handle, mut cancellation) = endpoint_cancellation();
    handle.cancel();

    let ActiveRunnerLifetimeAdvance::CleanupRequired(cleanup) =
        lifetime.advance(&mut cancellation).await
    else {
        panic!("pre-existing local cancellation must win");
    };

    assert!(matches!(
        cleanup.reason(),
        ActiveRunnerExitReason::LocalCancellation
    ));
    assert_revoked(&gate, &token);
    cleanup.close_local();
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cancel_ack_grace_expiry_is_protocol_failure_not_hard_deadline() {
    let clock = ManualClock::new(1_000);
    let (lifetime, control, gate, drops) =
        active([cancel_frame("cancel-expiring", 4)], clock.clone(), None).await;
    let token = gate.token().expect("active token");
    control.block_writes();
    let (_handle, mut cancellation) = endpoint_cancellation();
    let mut future = Box::pin(lifetime.advance(&mut cancellation));

    tokio::select! {
        biased;
        result = &mut future => panic!("blocked Cancel Ack completed: {}", super::support::outcome(&result)),
        () = tokio::task::yield_now() => {}
    }
    assert_revoked(&gate, &token);
    clock.set(1_300);
    control.allow_writes();

    let ActiveRunnerLifetimeAdvance::CleanupRequired(cleanup) = future.await else {
        panic!("expired Cancel Ack cannot continue");
    };
    assert!(matches!(
        cleanup.reason(),
        ActiveRunnerExitReason::ProtocolFailure(AsyncControlDriverError::DeadlineElapsed {
            operation: "CancelAttempt Ack write",
            deadline: 1_300,
            observed: 1_300,
        })
    ));
    assert_eq!(cleanup.final_state(), RunnerState::Exiting);
    cleanup.close_local();
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn local_cancel_during_blocked_remote_ack_wins_and_retains_cleanup() {
    let clock = ManualClock::new(1_000);
    let (lifetime, control, gate, drops) =
        active([fence_frame("fence-blocked", 4)], clock, None).await;
    let token = gate.token().expect("active token");
    control.block_writes();
    let (handle, mut cancellation) = endpoint_cancellation();
    let mut future = Box::pin(lifetime.advance(&mut cancellation));

    tokio::select! {
        biased;
        result = &mut future => panic!("blocked Fence Ack completed: {}", super::support::outcome(&result)),
        () = tokio::task::yield_now() => {}
    }
    assert_revoked(&gate, &token);
    handle.cancel();

    let ActiveRunnerLifetimeAdvance::CleanupRequired(cleanup) = future.await else {
        panic!("local cancellation cannot continue");
    };
    assert!(matches!(
        cleanup.reason(),
        ActiveRunnerExitReason::LocalCancellation
    ));
    assert_eq!(cleanup.final_state(), RunnerState::Exiting);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    cleanup.close_local();
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}
