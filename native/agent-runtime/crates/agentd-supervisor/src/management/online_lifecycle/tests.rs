use std::fmt::Debug;
use std::future::pending;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::time::Duration;

use super::sealed::Sealed;
use super::{
    CleanupDriveReport, CleanupStateError, OnlineLifecycleAdvance, OnlineLifecycleShutdown,
    SupervisorLifecycleClock, SupervisorLifecycleOwner, SupervisorOnlineLifecycle,
    SupervisorOnlineLifecycleTimer,
};

#[derive(Debug, Clone)]
struct ManualClock(Arc<AtomicI64>);

impl ManualClock {
    fn new(now_unix_ms: i64) -> Self {
        Self(Arc::new(AtomicI64::new(now_unix_ms)))
    }

    fn advance(&self, duration: Duration) {
        let millis = i64::try_from(duration.as_millis()).expect("test duration fits");
        self.0.fetch_add(millis, Ordering::SeqCst);
    }
}

impl SupervisorLifecycleClock for ManualClock {
    fn now_unix_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

#[derive(Debug)]
struct AdvancingTimer {
    clock: ManualClock,
    waits: Arc<AtomicUsize>,
}

impl AdvancingTimer {
    fn new(clock: ManualClock) -> (Arc<AtomicUsize>, Self) {
        let waits = Arc::new(AtomicUsize::new(0));
        (Arc::clone(&waits), Self { clock, waits })
    }
}

impl SupervisorOnlineLifecycleTimer for AdvancingTimer {
    async fn wait(&mut self, delay: Duration) {
        self.waits.fetch_add(1, Ordering::SeqCst);
        self.clock.advance(delay);
        tokio::task::yield_now().await;
    }
}

#[derive(Debug)]
struct FakeOwner {
    deadlines: Vec<i64>,
    ticks: usize,
    shutdowns: usize,
    fail_at_deadline: bool,
}

impl FakeOwner {
    fn new(deadlines: impl IntoIterator<Item = i64>) -> Self {
        Self {
            deadlines: deadlines.into_iter().collect(),
            ticks: 0,
            shutdowns: 0,
            fail_at_deadline: false,
        }
    }
}

impl Sealed for FakeOwner {}

impl SupervisorLifecycleOwner for FakeOwner {
    fn next_cleanup_deadline_unix_ms(&self) -> Option<i64> {
        self.deadlines.iter().copied().min()
    }

    fn drive_cleanup_tick(
        &mut self,
        clock: &dyn SupervisorLifecycleClock,
    ) -> Result<CleanupDriveReport, CleanupStateError> {
        let now = clock.now_unix_ms();
        if self.fail_at_deadline
            && self
                .next_cleanup_deadline_unix_ms()
                .is_some_and(|deadline| now >= deadline)
        {
            return Err(CleanupStateError::CleanupDeadlineElapsed);
        }
        let Some(index) = self.deadlines.iter().position(|deadline| now >= *deadline) else {
            return Ok(CleanupDriveReport::default());
        };
        self.deadlines.remove(index);
        self.ticks += 1;
        Ok(CleanupDriveReport {
            termination_attempts: 1,
            ..CleanupDriveReport::default()
        })
    }

    fn begin_shutdown(
        &mut self,
        shutdown: OnlineLifecycleShutdown,
        clock: &dyn SupervisorLifecycleClock,
    ) -> Result<(), CleanupStateError> {
        let now = clock.now_unix_ms();
        if shutdown.terminate_at_unix_ms() < now {
            return Err(CleanupStateError::InvalidTime);
        }
        self.shutdowns += 1;
        for deadline in &mut self.deadlines {
            *deadline = (*deadline).min(shutdown.terminate_at_unix_ms());
        }
        Ok(())
    }
}

#[tokio::test]
async fn blocked_management_read_cannot_block_the_online_deadline() {
    let clock = ManualClock::new(1_000);
    let (_, timer) = AdvancingTimer::new(clock.clone());
    let (_shutdown, mut lifecycle) =
        SupervisorOnlineLifecycle::new(FakeOwner::new([1_025]), clock, timer);

    let outcome = tokio::select! {
        biased;
        outcome = lifecycle.advance() => outcome,
        () = pending::<()>() => unreachable!("management read remains blocked"),
    };

    assert_eq!(
        outcome,
        OnlineLifecycleAdvance::Cleanup(CleanupDriveReport {
            termination_attempts: 1,
            ..CleanupDriveReport::default()
        })
    );
    assert_eq!(lifecycle.owner().ticks, 1);
}

#[tokio::test]
async fn one_due_attempt_does_not_advance_its_sibling() {
    let clock = ManualClock::new(10);
    let (_, timer) = AdvancingTimer::new(clock.clone());
    let (_shutdown, mut lifecycle) =
        SupervisorOnlineLifecycle::new(FakeOwner::new([10, 20]), clock, timer);

    assert!(matches!(
        lifecycle.advance().await,
        OnlineLifecycleAdvance::Cleanup(_)
    ));
    assert_eq!(lifecycle.owner().deadlines, [20]);
    assert_eq!(lifecycle.owner().ticks, 1);
}

#[tokio::test]
async fn equality_is_expired_without_waiting_an_extra_timer_turn() {
    let clock = ManualClock::new(50);
    let (waits, timer) = AdvancingTimer::new(clock.clone());
    let mut owner = FakeOwner::new([50]);
    owner.fail_at_deadline = true;
    let (_shutdown, mut lifecycle) = SupervisorOnlineLifecycle::new(owner, clock, timer);

    assert_eq!(
        lifecycle.advance().await,
        OnlineLifecycleAdvance::HardRestartRequired(CleanupStateError::CleanupDeadlineElapsed)
    );
    assert_eq!(waits.load(Ordering::SeqCst), 0);
    assert_eq!(lifecycle.owner().deadlines, [50]);
}

#[tokio::test]
async fn shutdown_wakes_idle_owner_and_closed_sender_does_not_spin() {
    let clock = ManualClock::new(100);
    let (waits, timer) = AdvancingTimer::new(clock.clone());
    let (shutdown, mut lifecycle) =
        SupervisorOnlineLifecycle::new(FakeOwner::new([500]), clock, timer);
    shutdown
        .request(OnlineLifecycleShutdown::new(250).expect("valid shutdown"))
        .expect("bounded request");

    assert_eq!(
        lifecycle.advance().await,
        OnlineLifecycleAdvance::ShutdownArmed
    );
    assert_eq!(lifecycle.owner().deadlines, [250]);
    assert_eq!(lifecycle.owner().shutdowns, 1);
    assert_eq!(waits.load(Ordering::SeqCst), 0);

    let clock = ManualClock::new(100);
    let (idle_waits, timer) = AdvancingTimer::new(clock.clone());
    let (idle_shutdown, mut idle_lifecycle) =
        SupervisorOnlineLifecycle::new(FakeOwner::new([]), clock, timer);
    drop(idle_shutdown);
    let blocked = tokio::time::timeout(Duration::from_millis(1), idle_lifecycle.advance()).await;
    assert!(blocked.is_err());
    assert!(!idle_lifecycle.shutdown_open);
    assert_eq!(idle_waits.load(Ordering::SeqCst), 0);
}
