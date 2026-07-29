use crate::control::authority::AuthorityError;
use crate::control::{ControlDriverError, ControlDriverEvent, ControlError, PrepareOutcome};
use crate::lifecycle::RunnerState;

use super::support::{
    ACTIVATION_NONCE, AGENT_RUN_VERSION, ATTEMPT_VERSION, ManualClock, SharedWriter,
    activate_frame_with, driver_with_frames, effective_facts, prepare_frame,
};

#[test]
fn activate_requires_the_exact_sealed_agent_run_version() {
    assert_rejected(
        |activate| activate.agent_run_version = AGENT_RUN_VERSION + 1,
        |error| {
            matches!(
                error,
                ControlError::ActivationAgentRunVersionMismatch {
                    expected: AGENT_RUN_VERSION,
                    actual
                } if *actual == AGENT_RUN_VERSION + 1
            )
        },
    );
}

#[test]
fn activate_requires_the_exact_sealed_attempt_version() {
    assert_rejected(
        |activate| activate.attempt_version = ATTEMPT_VERSION + 1,
        |error| {
            matches!(
                error,
                ControlError::ActivationAttemptVersionMismatch {
                    expected: ATTEMPT_VERSION,
                    actual
                } if *actual == ATTEMPT_VERSION + 1
            )
        },
    );
}

#[test]
fn activate_requires_a_raw_nonce_matching_the_sealed_sha256() {
    assert_rejected(
        |activate| {
            activate.activation_nonce = ACTIVATION_NONCE.to_vec();
            let last = activate.activation_nonce.last_mut().expect("fixture nonce");
            *last ^= 1;
        },
        |error| matches!(error, ControlError::ActivationNonceMismatch),
    );
}

fn assert_rejected(
    update: impl FnOnce(&mut agent_protocol::generated::v1::ActivateAttempt),
    expected: impl FnOnce(&ControlError) -> bool,
) {
    let clock = ManualClock::new(1_000);
    let frames = vec![
        prepare_frame("prepare-1", 2),
        activate_frame_with("activate-1", 3, 9_000, update),
    ];
    let mut driver = driver_with_frames(frames, SharedWriter::default(), clock.clone());
    let ControlDriverEvent::Prepare(PrepareOutcome::HydrationRequired(hydration)) =
        driver.receive_next().expect("Prepare")
    else {
        panic!("expected hydration request");
    };
    clock.set(1_100);
    driver
        .finish_prepare(hydration, effective_facts(1_050))
        .expect("AttemptPrepared");
    clock.set(1_200);

    let result = driver.receive_next();

    assert!(matches!(
        result,
        Err(ControlDriverError::Control(ref error)) if expected(error)
    ));
    assert!(driver.is_closed());
    assert_eq!(driver.state(), RunnerState::Exiting);
    assert!(matches!(
        driver.effect_token(),
        Err(AuthorityError::NotActive)
    ));
}
