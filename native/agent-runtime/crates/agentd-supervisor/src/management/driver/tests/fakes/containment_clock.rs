use super::{ContainmentState, EffectClockAdvance, ManualLifecycleClock};

impl ContainmentState {
    pub(in crate::management::driver::tests) fn advance_clock_on_next_spawn(
        &self,
        clock: ManualLifecycleClock,
        observed_at_unix_ms: i64,
    ) {
        *self.spawn_clock_advance.lock().expect("spawn clock hook") =
            Some(EffectClockAdvance::new(clock, observed_at_unix_ms));
    }

    pub(in crate::management::driver::tests) fn advance_clock_on_next_termination(
        &self,
        clock: ManualLifecycleClock,
        observed_at_unix_ms: i64,
    ) {
        *self
            .termination_clock_advance
            .lock()
            .expect("termination clock hook") =
            Some(EffectClockAdvance::new(clock, observed_at_unix_ms));
    }

    pub(in crate::management::driver::tests) fn advance_clock_on_next_reap(
        &self,
        clock: ManualLifecycleClock,
        observed_at_unix_ms: i64,
    ) {
        *self.reap_clock_advance.lock().expect("reap clock hook") =
            Some(EffectClockAdvance::new(clock, observed_at_unix_ms));
    }
}
