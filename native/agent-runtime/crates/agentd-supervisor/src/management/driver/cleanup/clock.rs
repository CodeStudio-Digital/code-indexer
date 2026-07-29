use super::super::state::CleanupStateError;
use crate::management::SupervisorLifecycleClock;

pub(in crate::management::driver) struct LifecycleClockSampler<'a> {
    clock: &'a dyn SupervisorLifecycleClock,
    floor_unix_ms: Option<i64>,
    previous: Option<i64>,
    previous_raw: Option<i64>,
}

impl<'a> LifecycleClockSampler<'a> {
    pub(in crate::management::driver) const fn new(
        clock: &'a dyn SupervisorLifecycleClock,
        previous: Option<i64>,
    ) -> Self {
        Self {
            clock,
            floor_unix_ms: None,
            previous,
            previous_raw: previous,
        }
    }

    pub(in crate::management::driver) const fn new_floored(
        clock: &FlooredLifecycleClock<'a>,
        previous: Option<i64>,
    ) -> Self {
        Self::new_floored_with_raw(clock, previous, None)
    }

    pub(in crate::management::driver) const fn new_floored_with_raw(
        clock: &FlooredLifecycleClock<'a>,
        previous: Option<i64>,
        previous_raw: Option<i64>,
    ) -> Self {
        Self {
            clock: clock.clock,
            floor_unix_ms: Some(clock.floor_unix_ms),
            previous,
            previous_raw,
        }
    }

    pub(in crate::management::driver) fn sample(&mut self) -> Result<i64, CleanupStateError> {
        let raw = self.clock.now_unix_ms();
        if raw <= 0 {
            return Err(CleanupStateError::InvalidTime);
        }
        if self.previous_raw.is_some_and(|previous| raw < previous) {
            return Err(CleanupStateError::ClockRegressed);
        }
        let observed = self.floor_unix_ms.map_or(raw, |floor| raw.max(floor));
        if self.previous.is_some_and(|previous| observed < previous) {
            return Err(CleanupStateError::ClockRegressed);
        }
        self.previous_raw = Some(raw);
        self.previous = Some(observed);
        Ok(observed)
    }

    pub(in crate::management::driver) const fn last(&self) -> Option<i64> {
        self.previous
    }

    pub(in crate::management::driver) const fn last_raw(&self) -> Option<i64> {
        self.previous_raw
    }
}

#[derive(Debug, Clone, Copy)]
pub(in crate::management::driver) struct FixedLifecycleClock(i64);

impl FixedLifecycleClock {
    pub(in crate::management::driver) const fn new(now_unix_ms: i64) -> Self {
        Self(now_unix_ms)
    }
}

impl SupervisorLifecycleClock for FixedLifecycleClock {
    fn now_unix_ms(&self) -> i64 {
        self.0
    }
}

#[derive(Debug)]
pub(in crate::management::driver) struct FlooredLifecycleClock<'a> {
    clock: &'a dyn SupervisorLifecycleClock,
    floor_unix_ms: i64,
}

impl<'a> FlooredLifecycleClock<'a> {
    pub(in crate::management::driver) const fn new(
        clock: &'a dyn SupervisorLifecycleClock,
        floor_unix_ms: i64,
    ) -> Self {
        Self {
            clock,
            floor_unix_ms,
        }
    }
}

impl SupervisorLifecycleClock for FlooredLifecycleClock<'_> {
    fn now_unix_ms(&self) -> i64 {
        let observed = self.clock.now_unix_ms();
        if observed <= 0 {
            observed
        } else {
            observed.max(self.floor_unix_ms)
        }
    }
}
