use tokio::time::{Instant, Interval, MissedTickBehavior, interval_at, timeout_at};

use super::{CleanupPumpConfig, HardRestartReason};

pub(super) struct CleanupPumpTimer {
    start: Instant,
    deadline: Instant,
    tick_interval: std::time::Duration,
    ticks: Option<Interval>,
}

impl CleanupPumpTimer {
    pub(super) fn seal(config: CleanupPumpConfig) -> Result<Self, HardRestartReason> {
        let start = Instant::now();
        let deadline = start
            .checked_add(config.hard_timeout)
            .ok_or(HardRestartReason::DrainDeadlineOverflow)?;
        Ok(Self {
            start,
            deadline,
            tick_interval: config.tick_interval,
            ticks: None,
        })
    }

    pub(super) fn is_expired(&self) -> bool {
        Instant::now() >= self.deadline
    }

    pub(super) async fn wait_for_tick(&mut self) -> bool {
        let ticks = self.ticks.get_or_insert_with(|| {
            let mut ticks = interval_at(self.start, self.tick_interval);
            ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
            ticks
        });
        timeout_at(self.deadline, ticks.tick()).await.is_ok()
    }
}
