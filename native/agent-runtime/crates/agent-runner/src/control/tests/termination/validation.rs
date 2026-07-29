use super::support::{active_driver, assert_revoked, decoded_output};
use crate::control::tests::asynchronous::driver;
use crate::control::tests::support::{ManualClock, cancel_frame_with, fence_frame_with};
use crate::control::{AsyncControlDriverError, ControlError, TextFieldError};
use crate::lifecycle::RunnerState;

#[tokio::test]
async fn cancel_rejects_invalid_reason() {
    let cases = [
        cancel_frame_with("cancel-unspecified", 4, |request| request.reason = 0),
        cancel_frame_with("cancel-unknown", 4, |request| request.reason = 99),
    ];

    for request in cases {
        let error = Box::pin(reject_active(request)).await;
        assert!(matches!(
            error,
            AsyncControlDriverError::Control(ControlError::InvalidCancelAttempt(_))
        ));
    }
}

#[tokio::test]
async fn cancel_rejects_invalid_codes_keys_and_grace() {
    let text_cases = [
        cancel_frame_with("cancel-empty-code", 4, |request| {
            request.reason_code.clear();
        }),
        cancel_frame_with("cancel-nul-code", 4, |request| {
            request.reason_code = "bad\0code".to_owned();
        }),
        cancel_frame_with("cancel-long-code", 4, |request| {
            request.reason_code = "a".repeat(129);
        }),
        cancel_frame_with("cancel-char-code", 4, |request| {
            request.reason_code = "bad code".to_owned();
        }),
        cancel_frame_with("cancel-empty-key", 4, |request| {
            request.idempotency_key.clear();
        }),
    ];
    for request in text_cases {
        let error = Box::pin(reject_active(request)).await;
        assert!(matches!(
            error,
            AsyncControlDriverError::Control(
                ControlError::InvalidTerminationReasonCode(_)
                    | ControlError::InvalidTerminationReasonCodeCharacters
                    | ControlError::InvalidIdempotencyKey(_)
            )
        ));
    }

    for request in [
        cancel_frame_with("cancel-expired-grace", 4, |request| {
            request.grace_deadline_at_unix_ms = 1_200;
        }),
        cancel_frame_with("cancel-excess-grace", 4, |request| {
            request.grace_deadline_at_unix_ms = 1_301;
        }),
    ] {
        assert!(matches!(
            Box::pin(reject_active(request)).await,
            AsyncControlDriverError::Control(ControlError::InvalidCancelAttempt(_))
        ));
    }
}

#[tokio::test]
async fn fence_rejects_invalid_epoch_timestamp_and_text() {
    let cases = [
        fence_frame_with("fence-stale", 4, |request| {
            request.replacement_fencing_epoch = 7;
        }),
        fence_frame_with("fence-zero-time", 4, |request| {
            request.fenced_at_unix_ms = 0;
        }),
        fence_frame_with("fence-future-time", 4, |request| {
            request.fenced_at_unix_ms = 1_201;
        }),
        fence_frame_with("fence-empty-code", 4, |request| {
            request.reason_code.clear();
        }),
        fence_frame_with("fence-empty-key", 4, |request| {
            request.idempotency_key.clear();
        }),
    ];

    for request in cases {
        let error = Box::pin(reject_active(request)).await;
        assert!(matches!(
            error,
            AsyncControlDriverError::Control(
                ControlError::InvalidFenceAttempt(_)
                    | ControlError::InvalidTerminationReasonCode(TextFieldError::Empty)
                    | ControlError::InvalidIdempotencyKey(TextFieldError::Empty)
            )
        ));
    }
}

#[tokio::test]
async fn cancel_and_fence_before_active_fail_closed() {
    let requests = [
        cancel_frame_with("cancel-before-active", 2, |request| {
            request.grace_deadline_at_unix_ms = 1_100;
        }),
        fence_frame_with("fence-before-active", 2, |request| {
            request.fenced_at_unix_ms = 1_000;
        }),
    ];

    for request in requests {
        let clock = ManualClock::new(1_000);
        let (mut driver, _) = driver([request], clock).await;
        let result = Box::pin(driver.receive_next()).await;
        assert!(matches!(
            result,
            Err(AsyncControlDriverError::Control(
                ControlError::TerminationNotActive
            ))
        ));
        assert!(driver.is_closed());
        assert_eq!(driver.state(), RunnerState::Exiting);
    }
}

async fn reject_active(request: Vec<u8>) -> AsyncControlDriverError {
    let clock = ManualClock::new(1_000);
    let (mut driver, control, gate) = Box::pin(active_driver([request], clock)).await;
    let token = gate.token().expect("active token");
    let error = Box::pin(driver.receive_next())
        .await
        .expect_err("invalid termination must fail");
    assert_revoked(&gate, &token);
    assert_eq!(decoded_output(&control).len(), 3);
    assert!(driver.is_closed());
    assert_eq!(driver.state(), RunnerState::Exiting);
    error
}
