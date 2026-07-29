use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::super::asynchronous::{GateControl, GateStream, driver_with_hello_and_raw_tail};
use super::super::support::{
    ManualClock, activate_frame_with_deadline, effective_facts, host_hello_frame,
    host_hello_frame_with, prepare_frame,
};
use crate::control::active_lifetime::{ActiveRunnerLifetime, ActiveRunnerLifetimeAdvance};
use crate::control::authority::EffectClock;
use crate::control::{ActivationOutcome, AuthorityError, ControlDriverEvent, PrepareOutcome};

pub(super) struct DropProbe(pub(super) Arc<AtomicUsize>);

impl Drop for DropProbe {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

pub(super) type TestLifetime = ActiveRunnerLifetime<GateStream, DropProbe>;

type ActiveFixture = (
    TestLifetime,
    GateControl,
    crate::control::authority::EffectGate,
    Arc<AtomicUsize>,
);

pub(super) trait ActiveTestClock: EffectClock + Clone + 'static {
    fn set_now(&self, now: i64);
}

impl ActiveTestClock for ManualClock {
    fn set_now(&self, now: i64) {
        self.set(now);
    }
}

pub(super) async fn active(
    tail: impl IntoIterator<Item = Vec<u8>>,
    clock: ManualClock,
    read_timeout_ms: Option<u64>,
) -> ActiveFixture {
    Box::pin(active_with_clock_and_raw_tail(
        tail,
        clock,
        read_timeout_ms,
        &[],
    ))
    .await
}

pub(super) async fn active_with_raw_tail(
    tail: impl IntoIterator<Item = Vec<u8>>,
    clock: ManualClock,
    read_timeout_ms: Option<u64>,
    raw_tail: &[u8],
) -> ActiveFixture {
    Box::pin(active_with_clock_and_raw_tail(
        tail,
        clock,
        read_timeout_ms,
        raw_tail,
    ))
    .await
}

pub(super) async fn active_with_clock<C>(
    tail: impl IntoIterator<Item = Vec<u8>>,
    clock: C,
    read_timeout_ms: Option<u64>,
) -> ActiveFixture
where
    C: ActiveTestClock,
{
    Box::pin(active_with_clock_and_raw_tail(
        tail,
        clock,
        read_timeout_ms,
        &[],
    ))
    .await
}

async fn active_with_clock_and_raw_tail<C>(
    tail: impl IntoIterator<Item = Vec<u8>>,
    clock: C,
    read_timeout_ms: Option<u64>,
    raw_tail: &[u8],
) -> ActiveFixture
where
    C: ActiveTestClock,
{
    let mut frames = vec![
        prepare_frame("prepare-active", 2),
        activate_frame_with_deadline("activate-active", 3, 9_000),
    ];
    frames.extend(tail);
    let host_hello = read_timeout_ms.map_or_else(host_hello_frame, |read_timeout_ms| {
        host_hello_frame_with(|hello| {
            hello
                .frame_limits
                .as_mut()
                .expect("frame limits")
                .read_timeout_ms = read_timeout_ms;
        })
    });
    let (mut driver, control) = Box::pin(driver_with_hello_and_raw_tail(
        frames,
        clock.clone(),
        &host_hello,
        raw_tail,
    ))
    .await;
    let ControlDriverEvent::Prepare(PrepareOutcome::HydrationRequired(token)) =
        Box::pin(driver.receive_next()).await.expect("Prepare")
    else {
        panic!("expected Prepare");
    };
    clock.set_now(1_100);
    driver
        .finish_prepare(token, effective_facts(1_050))
        .await
        .expect("AttemptPrepared");
    clock.set_now(1_200);
    assert!(matches!(
        Box::pin(driver.receive_next()).await.expect("Activate"),
        ControlDriverEvent::Activate(ActivationOutcome::Activated)
    ));
    let gate = driver.effect_gate_for_test().expect("active effect gate");
    let drops = Arc::new(AtomicUsize::new(0));
    (
        ActiveRunnerLifetime::new(driver, DropProbe(Arc::clone(&drops))),
        control,
        gate,
        drops,
    )
}

pub(super) fn assert_revoked(
    gate: &crate::control::authority::EffectGate,
    token: &crate::control::authority::EffectToken,
) {
    assert!(matches!(
        gate.with_effect_dispatch(token, |_| ()),
        Err(AuthorityError::Revoked)
    ));
}

pub(super) fn outcome<S, R>(value: &ActiveRunnerLifetimeAdvance<S, R>) -> &'static str {
    match value {
        ActiveRunnerLifetimeAdvance::Continue(_) => "continue",
        ActiveRunnerLifetimeAdvance::CleanupRequired(_) => "cleanup required",
    }
}
