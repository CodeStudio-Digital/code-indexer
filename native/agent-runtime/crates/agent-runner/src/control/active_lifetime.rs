use std::fmt::{self, Debug, Formatter};

use agent_platform::ipc::EndpointCancellation;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::{Instant, sleep_until};

use super::{AsyncControlDriverError, AsyncRunnerControlDriver, CancelOutcome, FenceOutcome};
use crate::lifecycle::RunnerState;

mod classification;

use classification::{
    PostActiveDisposition, classify_hard_deadline, classify_post_active_event, is_control_eof,
};

#[derive(Debug)]
pub enum ActiveRunnerExitReason {
    LocalRevocation,
    LocalCancellation,
    RemoteCancelled(CancelOutcome),
    Fenced(FenceOutcome),
    HardDeadlineElapsed,
    ControlEof,
    UnexpectedPostActiveEvent,
    ProtocolFailure(AsyncControlDriverError),
}

#[must_use = "active lifetime advance must retain or clean up its owner"]
pub enum ActiveRunnerLifetimeAdvance<S, R> {
    Continue(ActiveRunnerLifetime<S, R>),
    CleanupRequired(ActiveRunnerCleanup<R>),
}

#[must_use = "remaining runner resources require local close and supervisor reap"]
pub struct ActiveRunnerCleanup<R> {
    reason: ActiveRunnerExitReason,
    final_state: RunnerState,
    resources: R,
}

/// Single owner of active control state plus platform-specific resources.
pub struct ActiveRunnerLifetime<S, R> {
    driver: Box<AsyncRunnerControlDriver<S>>,
    resources: R,
}

impl<S, R> Debug for ActiveRunnerLifetime<S, R>
where
    S: AsyncRead + AsyncWrite + Unpin + 'static,
{
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ActiveRunnerLifetime")
            .field("state", &self.driver.state())
            .field("resources", &"[OWNED; REDACTED]")
            .finish_non_exhaustive()
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

impl<S, R> ActiveRunnerLifetime<S, R>
where
    S: AsyncRead + AsyncWrite + Unpin + 'static,
{
    pub(crate) fn new(driver: AsyncRunnerControlDriver<S>, resources: R) -> Self {
        Self {
            driver: Box::new(driver),
            resources,
        }
    }

    #[must_use]
    pub(crate) const fn state(&self) -> RunnerState {
        self.driver.state()
    }

    #[must_use]
    pub(crate) const fn is_control_closed(&self) -> bool {
        self.driver.is_closed()
    }

    pub(crate) fn revoke(self) -> ActiveRunnerCleanup<R> {
        self.cleanup(ActiveRunnerExitReason::LocalRevocation)
    }

    /// Advances at most one post-active control event.
    ///
    /// The returned future owns the complete lifetime. Dropping it before or
    /// after its first poll closes control, revokes effects, and drops every
    /// retained resource without spawning detached work.
    pub(crate) async fn advance(
        mut self,
        cancellation: &mut EndpointCancellation,
    ) -> ActiveRunnerLifetimeAdvance<S, R> {
        let hard_deadline = match self.driver.hard_deadline() {
            Ok(deadline) => deadline,
            Err(error) => {
                return ActiveRunnerLifetimeAdvance::CleanupRequired(
                    self.cleanup(classify_hard_deadline(error)),
                );
            }
        };
        let control = Box::pin(self.driver.receive_active(hard_deadline));
        let selected = tokio::select! {
            biased;
            () = cancellation.cancelled() => Selected::LocalCancellation,
            () = sleep_until(hard_deadline) => Selected::HardDeadline,
            result = control => Selected::Control(result),
        };
        match selected {
            Selected::LocalCancellation => cleanup(self, ActiveRunnerExitReason::LocalCancellation),
            Selected::HardDeadline => cleanup(self, ActiveRunnerExitReason::HardDeadlineElapsed),
            Selected::Control(Err(error)) => {
                let reason = if is_control_eof(&error) {
                    ActiveRunnerExitReason::ControlEof
                } else {
                    ActiveRunnerExitReason::ProtocolFailure(error)
                };
                cleanup(self, reason)
            }
            Selected::Control(Ok(event)) => {
                if Instant::now() >= hard_deadline {
                    return cleanup(self, ActiveRunnerExitReason::HardDeadlineElapsed);
                }
                match self.driver.reap_if_expired() {
                    Ok(true) => cleanup(self, ActiveRunnerExitReason::HardDeadlineElapsed),
                    Err(error) => cleanup(self, ActiveRunnerExitReason::ProtocolFailure(error)),
                    Ok(false) => match classify_post_active_event(event) {
                        PostActiveDisposition::Continue => {
                            ActiveRunnerLifetimeAdvance::Continue(self)
                        }
                        PostActiveDisposition::Cleanup(reason) => cleanup(self, reason),
                    },
                }
            }
        }
    }

    fn cleanup(mut self, reason: ActiveRunnerExitReason) -> ActiveRunnerCleanup<R> {
        self.driver.close();
        let final_state = self.driver.state();
        let Self { driver, resources } = self;
        drop(driver);
        ActiveRunnerCleanup {
            reason,
            final_state,
            resources,
        }
    }

    #[cfg(test)]
    pub(in crate::control) fn effect_gate_for_test(&self) -> Option<super::authority::EffectGate> {
        self.driver.effect_gate_for_test()
    }
}

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

    #[cfg(test)]
    pub(in crate::control) fn into_test_parts(self) -> (ActiveRunnerExitReason, RunnerState, R) {
        (self.reason, self.final_state, self.resources)
    }
}

enum Selected {
    LocalCancellation,
    HardDeadline,
    Control(Result<super::ControlDriverEvent, AsyncControlDriverError>),
}

fn cleanup<S, R>(
    lifetime: ActiveRunnerLifetime<S, R>,
    reason: ActiveRunnerExitReason,
) -> ActiveRunnerLifetimeAdvance<S, R>
where
    S: AsyncRead + AsyncWrite + Unpin + 'static,
{
    ActiveRunnerLifetimeAdvance::CleanupRequired(lifetime.cleanup(reason))
}
