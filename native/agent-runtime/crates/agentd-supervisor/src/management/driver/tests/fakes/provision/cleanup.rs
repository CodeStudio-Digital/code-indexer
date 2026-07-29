use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::management::driver::provision::{
    ProtectedLaunchCleanupPort, ProtectedLaunchCleanupProof,
};

use super::super::{EffectClockAdvance, FakeError, ManualLifecycleClock};

#[derive(Debug)]
pub(in crate::management::driver::tests) struct FakeCompletionCleanup {
    state: Arc<FakeCompletionCleanupState>,
}

impl FakeCompletionCleanup {
    pub(super) fn new(state: Arc<FakeCompletionCleanupState>) -> Self {
        Self { state }
    }
}

#[derive(Debug, Default)]
pub(in crate::management::driver::tests) struct FakeCompletionCleanupState {
    pub attempts: AtomicUsize,
    pub drops: AtomicUsize,
    failures_remaining: AtomicUsize,
    clock_advance: Mutex<Option<EffectClockAdvance>>,
}

impl FakeCompletionCleanupState {
    pub(super) fn fail_next(&self, failures: usize) {
        self.failures_remaining.store(failures, Ordering::SeqCst);
    }

    pub(in crate::management::driver::tests) fn advance_clock_on_next_cleanup(
        &self,
        clock: ManualLifecycleClock,
        observed_at_unix_ms: i64,
    ) {
        *self.clock_advance.lock().expect("cleanup clock hook") =
            Some(EffectClockAdvance::new(clock, observed_at_unix_ms));
    }
}

impl ProtectedLaunchCleanupPort for FakeCompletionCleanup {
    type Error = FakeError;

    fn try_cleanup(&mut self) -> Result<ProtectedLaunchCleanupProof, Self::Error> {
        self.state.attempts.fetch_add(1, Ordering::SeqCst);
        let clock_advance = self
            .state
            .clock_advance
            .lock()
            .expect("cleanup clock hook")
            .take();
        if let Some(advance) = clock_advance {
            advance.fire();
        }
        if self
            .state
            .failures_remaining
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                remaining.checked_sub(1)
            })
            .is_ok()
        {
            return Err(FakeError::Provision);
        }
        Ok(ProtectedLaunchCleanupProof::completed())
    }
}

impl Drop for FakeCompletionCleanup {
    fn drop(&mut self) {
        self.state.drops.fetch_add(1, Ordering::SeqCst);
    }
}
