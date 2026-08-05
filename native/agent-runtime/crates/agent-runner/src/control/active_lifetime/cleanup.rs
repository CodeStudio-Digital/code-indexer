use crate::lifecycle::RunnerState;

use super::{ActiveRunnerCleanup, ActiveRunnerExitReason};

impl<R> ActiveRunnerCleanup<R> {
    #[must_use]
    pub(crate) const fn reason(&self) -> &ActiveRunnerExitReason {
        &self.reason
    }

    #[must_use]
    pub(crate) const fn final_state(&self) -> RunnerState {
        self.final_state
    }

    pub(crate) fn close_local(self) {
        drop(self);
    }

    pub(crate) fn into_resources(self) -> R {
        self.resources
    }

    #[cfg(test)]
    pub(in crate::control) fn into_test_parts(self) -> (ActiveRunnerExitReason, RunnerState, R) {
        (self.reason, self.final_state, self.resources)
    }
}
