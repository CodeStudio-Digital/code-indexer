use agent_engine::ports::{AuthorityCheckpoint, AuthorityPort};

use crate::control::{ActivationOutcome, AuthorityError, ControlDriverEvent, PrepareOutcome};
use crate::engine_authority::EngineAuthority;
use crate::lifecycle::RunnerState;

use super::support::{ManualClock, activate_frame_with_deadline, effective_facts, prepare_frame};

mod support;
pub(super) use support::{GateControl, GateStream, driver, driver_with_hello_and_raw_tail};

fn assert_send<T: Send>(_: &T) {}

#[tokio::test]
async fn happy_path_is_send_and_reaches_active_only_after_physical_commits() {
    let clock = ManualClock::new(1_000);
    let (mut driver, _) = driver(
        [
            prepare_frame("prepare-1", 2),
            activate_frame_with_deadline("activate-1", 3, 9_000),
        ],
        clock.clone(),
    )
    .await;
    let receive = driver.receive_next();
    assert_send(&receive);
    let ControlDriverEvent::Prepare(PrepareOutcome::HydrationRequired(token)) =
        Box::pin(receive).await.expect("Prepare")
    else {
        panic!("expected Prepare");
    };
    clock.set(1_100);
    let finish = driver.finish_prepare(token, effective_facts(1_050));
    assert_send(&finish);
    finish.await.expect("AttemptPrepared");
    assert_eq!(driver.state(), RunnerState::Prepared);
    assert!(driver.take_execution_seed().is_none());
    assert!(driver.active_effect_gate().is_none());
    clock.set(1_200);
    assert!(matches!(
        Box::pin(driver.receive_next()).await.expect("Activate"),
        ControlDriverEvent::Activate(ActivationOutcome::Activated)
    ));
    assert_eq!(driver.state(), RunnerState::Active);
    let seed = driver
        .take_execution_seed()
        .expect("validated execution seed after activation");
    assert_eq!(
        seed.as_wire()
            .provider_binding
            .as_ref()
            .expect("provider binding")
            .effective_model,
        "gpt-5"
    );
    assert!(driver.take_execution_seed().is_none());
    let mut authority = EngineAuthority::new(
        driver
            .active_effect_gate()
            .expect("active shared effect gate"),
    );
    authority
        .verify(AuthorityCheckpoint::ProviderStart)
        .await
        .expect("live engine authority");
    driver.close();
    assert!(matches!(
        authority
            .verify(AuthorityCheckpoint::TerminalDecision)
            .await,
        Err(AuthorityError::Revoked)
    ));
}

#[tokio::test]
async fn never_polled_receive_revokes_active_authority_and_closes() {
    let clock = ManualClock::new(1_000);
    let (mut driver, _) = driver(
        [
            prepare_frame("prepare-1", 2),
            activate_frame_with_deadline("activate-1", 3, 9_000),
        ],
        clock.clone(),
    )
    .await;
    let ControlDriverEvent::Prepare(PrepareOutcome::HydrationRequired(token)) =
        Box::pin(driver.receive_next()).await.expect("Prepare")
    else {
        panic!("expected Prepare");
    };
    clock.set(1_100);
    driver
        .finish_prepare(token, effective_facts(1_050))
        .await
        .expect("AttemptPrepared");
    clock.set(1_200);
    Box::pin(driver.receive_next()).await.expect("Activate");
    let gate = driver.effect_gate_for_test().expect("active effect gate");
    let token = gate.token().expect("active effect token");

    let never_polled = driver.receive_next();
    drop(never_polled);

    assert!(driver.is_closed());
    assert_eq!(driver.state(), RunnerState::Exiting);
    assert!(matches!(
        gate.with_effect_dispatch(&token, |_| ()),
        Err(AuthorityError::Revoked)
    ));
}

#[tokio::test]
async fn never_polled_finish_prepare_closes_without_prepared_state() {
    let clock = ManualClock::new(1_000);
    let (mut driver, _) = driver([prepare_frame("prepare-1", 2)], clock).await;
    let ControlDriverEvent::Prepare(PrepareOutcome::HydrationRequired(token)) =
        Box::pin(driver.receive_next()).await.expect("Prepare")
    else {
        panic!("expected Prepare");
    };

    let never_polled = driver.finish_prepare(token, effective_facts(1_050));
    drop(never_polled);

    assert!(driver.is_closed());
    assert_eq!(driver.state(), RunnerState::Exiting);
}

#[tokio::test]
async fn cancelled_prepared_and_ack_writes_never_commit_lifecycle_state() {
    let clock = ManualClock::new(1_000);
    let (mut preparing, prepare_gate) =
        driver([prepare_frame("prepare-1", 2)], clock.clone()).await;
    let ControlDriverEvent::Prepare(PrepareOutcome::HydrationRequired(token)) =
        Box::pin(preparing.receive_next()).await.expect("Prepare")
    else {
        panic!("expected Prepare");
    };
    clock.set(1_100);
    prepare_gate.block_writes();
    let mut blocked = Box::pin(preparing.finish_prepare(token, effective_facts(1_050)));
    tokio::select! {
        biased;
        result = &mut blocked => panic!("write unexpectedly completed: {result:?}"),
        () = tokio::task::yield_now() => {}
    }
    drop(blocked);
    assert!(preparing.is_closed());
    assert_eq!(preparing.state(), RunnerState::Exiting);

    let (mut activating, activate_gate) = driver(
        [
            prepare_frame("prepare-2", 2),
            activate_frame_with_deadline("activate-2", 3, 9_000),
        ],
        clock.clone(),
    )
    .await;
    let ControlDriverEvent::Prepare(PrepareOutcome::HydrationRequired(token)) =
        Box::pin(activating.receive_next()).await.expect("Prepare")
    else {
        panic!("expected Prepare");
    };
    clock.set(1_200);
    activating
        .finish_prepare(token, effective_facts(1_150))
        .await
        .expect("AttemptPrepared");
    activate_gate.block_writes();
    let mut blocked = Box::pin(activating.receive_next());
    tokio::select! {
        biased;
        result = &mut blocked => panic!("write unexpectedly completed: {result:?}"),
        () = tokio::task::yield_now() => {}
    }
    drop(blocked);
    assert!(activating.is_closed());
    assert_eq!(activating.state(), RunnerState::Exiting);
}
