use super::*;

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn cancelled_wait_keeps_owner_and_original_deadline_in_the_pump() {
    let config = CleanupPumpConfig::new(Duration::from_millis(10), Duration::from_millis(25))
        .expect("config");
    let mut pump =
        SupervisorCleanupPump::new(FakeOwner::draining(2), config).expect("fully scheduled");
    let mut advance = Box::pin(pump.advance());

    tokio::select! {
        biased;
        outcome = &mut advance => panic!("advance unexpectedly finished: {outcome:?}"),
        () = tokio::task::yield_now() => {}
    }
    drop(advance);
    assert_eq!(pump.owner.ticks, 1);
    assert_eq!(pump.owner.owned, 1);

    tokio::time::advance(Duration::from_millis(30)).await;
    assert_eq!(
        pump.advance().await,
        CleanupPumpOutcome::HardRestartRequired(HardRestartReason::DrainDeadlineElapsed)
    );
    let restart = pump
        .into_hard_restart()
        .expect("original deadline retained");
    assert_eq!(restart.owner().ticks, 1);
    assert_eq!(restart.owner().owned, 1);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn delay_before_first_advance_cannot_reset_the_transfer_deadline() {
    let config = CleanupPumpConfig::new(Duration::from_millis(10), Duration::from_millis(25))
        .expect("config");
    let mut pump =
        SupervisorCleanupPump::new(FakeOwner::draining(1), config).expect("fully scheduled");

    tokio::time::advance(Duration::from_millis(30)).await;

    assert_eq!(
        pump.advance().await,
        CleanupPumpOutcome::HardRestartRequired(HardRestartReason::DrainDeadlineElapsed)
    );
    let restart = pump
        .into_hard_restart()
        .expect("transfer deadline retained");
    assert_eq!(restart.owner().ticks, 0);
    assert_eq!(restart.owner().owned, 1);
}

#[tokio::test(flavor = "current_thread")]
async fn tick_crossing_hard_deadline_never_reports_drained() {
    let config = CleanupPumpConfig::new(Duration::from_millis(1), Duration::from_millis(100))
        .expect("config");
    let owner = FakeOwner::delayed_tick(Duration::from_millis(200));
    let mut pump = SupervisorCleanupPump::new(owner, config).expect("fully scheduled");

    assert_eq!(
        pump.advance().await,
        CleanupPumpOutcome::HardRestartRequired(HardRestartReason::DrainDeadlineElapsed)
    );
    let restart = pump
        .into_hard_restart()
        .expect("late tick requires restart");
    assert_eq!(restart.owner().ticks, 1);
    assert_eq!(restart.owner().owned, 0);
    assert_eq!(restart.owner().scheduled, 0);
}
