use std::sync::atomic::Ordering;
use std::time::Duration;

use agent_platform::ipc::endpoint_cancellation;

use super::support::{active, assert_revoked, outcome};
use crate::control::active_lifetime::{ActiveRunnerExitReason, ActiveRunnerLifetimeAdvance};
use crate::control::tests::support::{ManualClock, activate_frame_with_deadline};
use crate::lifecycle::RunnerState;

#[tokio::test]
async fn never_polled_and_mid_poll_drop_revoke_and_release_resources() {
    for poll_once in [false, true] {
        let clock = ManualClock::new(1_000);
        let (lifetime, _, gate, drops) = active([], clock, None).await;
        let token = gate.token().expect("effect token");
        let (_handle, mut cancellation) = endpoint_cancellation();
        let mut future = Box::pin(lifetime.advance(&mut cancellation));
        if poll_once {
            tokio::select! {
                biased;
                result = &mut future => {
                    panic!(
                        "idle advance completed: {}",
                        outcome(&result)
                    )
                }
                () = tokio::task::yield_now() => {}
            }
        }
        drop(future);

        assert_revoked(&gate, &token);
        assert_eq!(drops.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn idle_outlives_read_timeout_then_cancel_returns_cleanup_owner() {
    let clock = ManualClock::new(1_000);
    let (lifetime, _, gate, drops) = active([], clock, Some(1)).await;
    let token = gate.token().expect("effect token");
    let (handle, mut cancellation) = endpoint_cancellation();
    let mut future = Box::pin(lifetime.advance(&mut cancellation));

    tokio::select! {
        biased;
        result = &mut future => {
            panic!("idle used read timeout: {}", outcome(&result))
        }
        () = tokio::time::sleep(Duration::from_millis(10)) => {}
    }
    handle.cancel();
    let ActiveRunnerLifetimeAdvance::CleanupRequired(cleanup) = future.await else {
        panic!("cancel must require cleanup");
    };

    assert!(matches!(
        cleanup.reason(),
        ActiveRunnerExitReason::LocalCancellation
    ));
    assert_eq!(cleanup.final_state(), RunnerState::Exiting);
    assert_revoked(&gate, &token);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    cleanup.close_local();
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn precancel_and_hard_deadline_win_over_ready_control_frames() {
    let duplicate = activate_frame_with_deadline("activate-active", 3, 9_000);
    let clock = ManualClock::new(1_000);
    let (cancelled, _, gate, drops) = active([duplicate.clone()], clock, None).await;
    let token = gate.token().expect("effect token");
    let (handle, mut cancellation) = endpoint_cancellation();
    handle.cancel();
    let ActiveRunnerLifetimeAdvance::CleanupRequired(cleanup) =
        cancelled.advance(&mut cancellation).await
    else {
        panic!("pre-cancel must win");
    };
    assert!(matches!(
        cleanup.reason(),
        ActiveRunnerExitReason::LocalCancellation
    ));
    assert_revoked(&gate, &token);
    cleanup.close_local();
    assert_eq!(drops.load(Ordering::SeqCst), 1);

    let deadline_clock = ManualClock::new(1_000);
    let (expired, _, gate, drops) = active([duplicate], deadline_clock.clone(), None).await;
    let token = gate.token().expect("effect token");
    deadline_clock.set(9_000);
    let (_handle, mut cancellation) = endpoint_cancellation();
    let ActiveRunnerLifetimeAdvance::CleanupRequired(cleanup) =
        expired.advance(&mut cancellation).await
    else {
        panic!("deadline must win");
    };
    assert!(matches!(
        cleanup.reason(),
        ActiveRunnerExitReason::HardDeadlineElapsed
    ));
    assert_revoked(&gate, &token);
    cleanup.close_local();
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}
