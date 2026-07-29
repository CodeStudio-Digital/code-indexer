use std::sync::atomic::Ordering;
use std::time::Duration;

use crate::management::driver::tests::fakes::{
    FakeContainment, FakeProvisioner, ManualLifecycleClock,
};
use crate::management::driver::tests::support::{
    TestWriter, established, launch_attempt, launch_frame, peer_authority, trusted_runner,
};
use crate::management::{
    AdmissionClosureReason, CleanupPumpConfig, CleanupPumpOutcome, OnlineLifecycleAdvance,
    OnlineLifecycleShutdown, SupervisorCleanupPump, SupervisorLifecycleOwner,
    SupervisorOnlineLifecycle, SupervisorPhysicalDriver, TokioSupervisorLifecycleTimer,
};

const NOW: i64 = 4_102_444_699_800;

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn shutdown_closes_admission_and_schedules_every_owned_attempt() {
    let channel = established(
        vec![launch_frame(launch_attempt(), "launch", 2)],
        TestWriter::default(),
    );
    let (containment, state) = FakeContainment::healthy();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    driver.process_next_at(1_000).expect("launch");
    let clock = ManualLifecycleClock::new(NOW);
    let (shutdown, mut lifecycle) =
        SupervisorOnlineLifecycle::new(driver, clock, TokioSupervisorLifecycleTimer);
    shutdown
        .request(OnlineLifecycleShutdown::new(NOW + 50).expect("shutdown"))
        .expect("request");

    assert_eq!(
        lifecycle.advance().await,
        OnlineLifecycleAdvance::ShutdownArmed
    );
    assert_eq!(
        lifecycle.owner().state().closure_reason(),
        Some(AdmissionClosureReason::Shutdown)
    );
    assert_eq!(lifecycle.owner().owned_attempts(), 1);
    assert_eq!(lifecycle.owner().state().pending_cleanup_count(), 1);
    assert_eq!(
        SupervisorLifecycleOwner::next_cleanup_deadline_unix_ms(lifecycle.owner()),
        Some(NOW + 50)
    );
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn empty_shutdown_hands_a_closed_owner_to_a_clean_drain() {
    let channel = established(Vec::new(), TestWriter::default());
    let (containment, _state) = FakeContainment::healthy_with_groups(0);
    let driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    let clock = ManualLifecycleClock::new(NOW);
    let (shutdown, mut lifecycle) =
        SupervisorOnlineLifecycle::new(driver, clock, TokioSupervisorLifecycleTimer);
    shutdown
        .request(OnlineLifecycleShutdown::new(NOW + 1).expect("shutdown"))
        .expect("request");
    assert_eq!(
        lifecycle.advance().await,
        OnlineLifecycleAdvance::ShutdownArmed
    );

    let driver = lifecycle.into_owner();
    let config =
        CleanupPumpConfig::new(Duration::from_millis(1), Duration::from_secs(1)).expect("config");
    let mut pump = SupervisorCleanupPump::new(driver, config).expect("closed and scheduled");
    assert_eq!(pump.advance().await, CleanupPumpOutcome::Drained);
    let driver = pump.into_owner().expect("drained owner");
    assert_eq!(
        driver.state().closure_reason(),
        Some(AdmissionClosureReason::Shutdown)
    );
    assert_eq!(driver.owned_attempts(), 0);
}
