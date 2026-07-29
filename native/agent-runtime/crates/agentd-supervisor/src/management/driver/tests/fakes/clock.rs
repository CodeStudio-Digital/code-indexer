use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use crate::management::SupervisorLifecycleClock;

#[derive(Debug, Clone)]
pub(in crate::management::driver::tests) struct ManualLifecycleClock(Arc<AtomicI64>);

impl ManualLifecycleClock {
    pub(in crate::management::driver::tests) fn new(now_unix_ms: i64) -> Self {
        Self(Arc::new(AtomicI64::new(now_unix_ms)))
    }

    pub(in crate::management::driver::tests) fn set(&self, observed_at_unix_ms: i64) {
        self.0.store(observed_at_unix_ms, Ordering::SeqCst);
    }
}

impl SupervisorLifecycleClock for ManualLifecycleClock {
    fn now_unix_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Clone)]
pub(in crate::management::driver::tests) struct EffectClockAdvance {
    clock: ManualLifecycleClock,
    observed_at_unix_ms: i64,
}

impl EffectClockAdvance {
    pub(in crate::management::driver::tests) const fn new(
        clock: ManualLifecycleClock,
        observed_at_unix_ms: i64,
    ) -> Self {
        Self {
            clock,
            observed_at_unix_ms,
        }
    }

    pub(super) fn fire(self) {
        self.clock.set(self.observed_at_unix_ms);
    }
}
