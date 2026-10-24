use std::fmt::{self, Debug, Formatter};

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

impl<R> Debug for ActiveRunnerCleanup<R> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ActiveRunnerCleanup")
            .field("reason", &self.reason)
            .field("final_state", &self.final_state)
            .field("control_closed", &true)
            .field("supervisor_reap_required", &true)
            .field("resources", &"[OWNED; REDACTED]")
            .finish()
    }
}
