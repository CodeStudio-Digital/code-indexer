use std::fmt::{self, Debug, Formatter};

use agent_platform::ipc::EndpointCancellation;
use agent_protocol::generated::v1 as wire;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::{Instant, sleep_until};

use super::{AsyncControlDriverError, AsyncRunnerControlDriver, CancelOutcome, FenceOutcome};
use crate::lifecycle::RunnerState;

mod classification;
mod cleanup;
mod heartbeat;

use classification::{
    PostActiveDisposition, classify_hard_deadline, classify_post_active_event, is_control_eof,
};
use heartbeat::ActiveHeartbeatSchedule;

const TERMINATION_ACK_DRAIN: std::time::Duration = std::time::Duration::from_millis(50);

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
    heartbeat: ActiveHeartbeatSchedule,
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
    pub(crate) fn new(
        driver: AsyncRunnerControlDriver<S>,
        resources: R,
    ) -> Result<Self, AsyncControlDriverError> {
        let heartbeat = ActiveHeartbeatSchedule::new(&driver)?;
        Ok(Self {
            driver: Box::new(driver),
            resources,
            heartbeat,
        })
    }

    #[must_use]
    pub(crate) const fn state(&self) -> RunnerState {
        self.driver.state()
    }

    #[must_use]
    pub(crate) const fn is_control_closed(&self) -> bool {
        self.driver.is_closed()
    }

    pub(crate) const fn resources_mut(&mut self) -> &mut R {
        &mut self.resources
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
        self,
        cancellation: &mut EndpointCancellation,
    ) -> ActiveRunnerLifetimeAdvance<S, R> {
        self.advance_with_resource_sample(cancellation, || Ok(wire::ResourceSample::default()))
            .await
    }

    pub(crate) async fn advance_with_resource_sample<F>(
        mut self,
        cancellation: &mut EndpointCancellation,
        resource_sample: F,
    ) -> ActiveRunnerLifetimeAdvance<S, R>
    where
        F: FnOnce() -> Result<wire::ResourceSample, AsyncControlDriverError>,
    {
        let hard_deadline = match self.driver.hard_deadline() {
            Ok(deadline) => deadline,
            Err(error) => {
                return ActiveRunnerLifetimeAdvance::CleanupRequired(
                    self.cleanup(classify_hard_deadline(error)),
                );
            }
        };
        let heartbeat_wake = self.heartbeat.next_wake(hard_deadline);
        let control = Box::pin(self.driver.receive_active(heartbeat_wake, hard_deadline));
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
            Selected::Control(Ok(None)) => {
                if Instant::now() >= hard_deadline {
                    return cleanup(self, ActiveRunnerExitReason::HardDeadlineElapsed);
                }
                let resources = match resource_sample() {
                    Ok(value) => value,
                    Err(error) => {
                        return cleanup(self, ActiveRunnerExitReason::ProtocolFailure(error));
                    }
                };
                if let Err(error) = self.heartbeat.emit(&mut self.driver, resources).await {
                    return cleanup(self, ActiveRunnerExitReason::ProtocolFailure(error));
                }
                ActiveRunnerLifetimeAdvance::Continue(self)
            }
            Selected::Control(Ok(Some(event))) => {
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
                        PostActiveDisposition::Cleanup(reason) => {
                            // V1 has no ACK-of-ACK. Keep the verified Control
                            // owner alive briefly after the physically flushed
                            // terminal response so the Host framing loop can
                            // commit it before Windows reports peer EOF.
                            if matches!(
                                reason,
                                ActiveRunnerExitReason::RemoteCancelled(_)
                                    | ActiveRunnerExitReason::Fenced(_)
                            ) {
                                tokio::time::sleep(TERMINATION_ACK_DRAIN).await;
                            }
                            cleanup(self, reason)
                        }
                    },
                }
            }
        }
    }

    fn cleanup(mut self, reason: ActiveRunnerExitReason) -> ActiveRunnerCleanup<R> {
        self.driver.close();
        let final_state = self.driver.state();
        let Self {
            driver, resources, ..
        } = self;
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

enum Selected {
    LocalCancellation,
    HardDeadline,
    Control(Result<Option<super::ControlDriverEvent>, AsyncControlDriverError>),
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
