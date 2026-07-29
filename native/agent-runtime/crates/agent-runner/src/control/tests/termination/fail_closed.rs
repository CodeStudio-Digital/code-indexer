use super::support::{ScriptClock, active_driver, assert_revoked, decoded_output};
use crate::control::tests::support::{ManualClock, cancel_frame, fence_frame};
use crate::control::{AsyncControlDriverError, AuthorityError};
use crate::lifecycle::RunnerState;

#[tokio::test]
async fn blocked_termination_ack_revokes_before_write_and_never_installs_state() {
    for request in [
        cancel_frame("cancel-blocked", 4),
        fence_frame("fence-blocked", 4),
    ] {
        let clock = ManualClock::new(1_000);
        let (mut driver, control, gate) = Box::pin(active_driver([request], clock)).await;
        let token = gate.token().expect("active token");
        control.block_writes();

        let mut blocked = Box::pin(driver.receive_next());
        tokio::select! {
            biased;
            result = &mut blocked => panic!("termination Ack unexpectedly completed: {result:?}"),
            () = tokio::task::yield_now() => {}
        }

        assert_revoked(&gate, &token);
        assert_eq!(decoded_output(&control).len(), 3);
        drop(blocked);
        assert!(driver.is_closed());
        assert_eq!(driver.state(), RunnerState::Exiting);
    }
}

#[tokio::test]
async fn ack_completion_at_cancel_or_fence_deadline_fails_closed() {
    for (request, deadline, operation) in [
        (
            cancel_frame("cancel-deadline", 4),
            1_300,
            "CancelAttempt Ack write",
        ),
        (
            fence_frame("fence-deadline", 4),
            2_200,
            "FenceAttempt Ack write",
        ),
    ] {
        let clock = ScriptClock::new(vec![1_200, 1_200, 1_200, 1_200, 1_200, deadline]);
        let (mut driver, control, gate) = Box::pin(active_driver([request], clock.clone())).await;
        let token = gate.token().expect("active token");
        clock.arm();

        let result = Box::pin(driver.receive_next()).await;

        assert!(matches!(
            result,
            Err(AsyncControlDriverError::DeadlineElapsed {
                operation: actual_operation,
                deadline: actual_deadline,
                observed,
            }) if actual_operation == operation
                && actual_deadline == deadline
                && observed == deadline
        ));
        assert_revoked(&gate, &token);
        assert_eq!(decoded_output(&control).len(), 4);
        assert!(driver.is_closed());
        assert_eq!(driver.state(), RunnerState::Exiting);
    }
}

#[tokio::test]
async fn clock_regression_after_physical_ack_never_publishes_termination() {
    let clock = ScriptClock::new(vec![1_200, 1_200, 1_200, 1_200, 1_200, 1_199]);
    let (mut driver, control, gate) = Box::pin(active_driver(
        [fence_frame("fence-regression", 4)],
        clock.clone(),
    ))
    .await;
    let token = gate.token().expect("active token");
    clock.arm();

    let result = Box::pin(driver.receive_next()).await;

    assert!(matches!(
        result,
        Err(AsyncControlDriverError::ClockRegressed {
            operation: "FenceAttempt Ack write",
            started_at: 1_200,
            completed_at: 1_199,
        })
    ));
    assert!(matches!(
        gate.with_effect_dispatch(&token, |_| ()),
        Err(AuthorityError::Revoked | AuthorityError::ClockRegressed { .. })
    ));
    assert_eq!(decoded_output(&control).len(), 4);
    assert!(driver.is_closed());
    assert_eq!(driver.state(), RunnerState::Exiting);
}
