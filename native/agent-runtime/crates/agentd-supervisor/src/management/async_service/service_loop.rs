use agent_platform::containment::ContainmentPort;
use agent_protocol::management_channel::AsyncManagementEvent;

use super::{
    ServiceMode, SupervisorAsyncService, SupervisorAsyncServiceAdvance,
    SupervisorAsyncServiceOutcome, SupervisorManagementTerminal,
};
use crate::management::{
    OnlineLifecycleAdvance, ProtectedLaunchProvisionPort, SupervisorLifecycleClock,
    SupervisorOnlineLifecycleTimer,
};

impl<P, V, C, T> SupervisorAsyncService<P, V, C, T>
where
    P: ContainmentPort + Send + Sync + 'static,
    P::Group: Send + 'static,
    V: ProtectedLaunchProvisionPort + Send + Sync + 'static,
    C: SupervisorLifecycleClock,
    T: SupervisorOnlineLifecycleTimer,
{
    /// Runs until all physical owners drain or a lifecycle invariant requires
    /// process replacement. The returned outcome always carries the core.
    pub async fn run(mut self) -> SupervisorAsyncServiceOutcome<P, V> {
        loop {
            match self.mode {
                ServiceMode::Draining(terminal) if self.physically_drained() => {
                    return SupervisorAsyncServiceOutcome::PhysicallyDrained {
                        owner: self.lifecycle.into_owner(),
                        terminal,
                    };
                }
                ServiceMode::HardRestart(error) if self.pending_launch.is_none() => {
                    return SupervisorAsyncServiceOutcome::HardRestartRequired {
                        owner: self.lifecycle.into_owner(),
                        error,
                    };
                }
                ServiceMode::Online | ServiceMode::Draining(_) | ServiceMode::HardRestart(_) => {}
            }
            let _ = self.advance().await;
        }
    }

    /// Advances exactly one management or lifecycle transition.
    ///
    /// Cancellation is safe: the protocol reader remains in its actor task and
    /// lifecycle deadlines, owners, and schedules remain in `self`.
    pub async fn advance(&mut self) -> SupervisorAsyncServiceAdvance<P::Error> {
        if let ServiceMode::HardRestart(error) = self.mode
            && self.pending_launch.is_none()
        {
            return SupervisorAsyncServiceAdvance::HardRestartRequired(error);
        }
        if self.pending_write.is_some() {
            return self.resume_pending_write().await;
        }
        if self.pending_launch.is_some() {
            return Box::pin(self.resume_pending_launch()).await;
        }
        if let Some(step) = self.queue_next_lifecycle_fact().await {
            return step;
        }
        if matches!(
            self.mode,
            ServiceMode::Draining(terminal)
                if terminal != SupervisorManagementTerminal::Shutdown
        ) {
            return self.advance_lifecycle().await;
        }
        let wake = tokio::select! {
            biased;
            lifecycle = self.lifecycle.advance() => ServiceWake::Lifecycle(lifecycle),
            event = self.actor.receive() => ServiceWake::Management(event),
        };
        match wake {
            ServiceWake::Lifecycle(outcome) => self.apply_lifecycle(outcome),
            ServiceWake::Management(Some(Ok(event))) => self.dispatch(event).await,
            ServiceWake::Management(Some(Err(error))) => self.fail_channel(error),
            ServiceWake::Management(None) => self.fail_channel(
                agent_protocol::management_channel::AsyncManagementActorError::ActorClosed,
            ),
        }
    }

    async fn advance_lifecycle(&mut self) -> SupervisorAsyncServiceAdvance<P::Error> {
        let outcome = self.lifecycle.advance().await;
        self.apply_lifecycle(outcome)
    }

    pub(super) const fn apply_lifecycle(
        &mut self,
        outcome: OnlineLifecycleAdvance,
    ) -> SupervisorAsyncServiceAdvance<P::Error> {
        match outcome {
            OnlineLifecycleAdvance::Cleanup(report) => {
                SupervisorAsyncServiceAdvance::Cleanup(report)
            }
            OnlineLifecycleAdvance::ShutdownArmed => {
                self.mode = ServiceMode::Draining(SupervisorManagementTerminal::Shutdown);
                SupervisorAsyncServiceAdvance::ShutdownArmed
            }
            OnlineLifecycleAdvance::HardRestartRequired(error) => {
                self.mode = ServiceMode::HardRestart(error);
                SupervisorAsyncServiceAdvance::HardRestartRequired(error)
            }
        }
    }
}

enum ServiceWake {
    Lifecycle(OnlineLifecycleAdvance),
    Management(
        Option<
            Result<
                AsyncManagementEvent,
                agent_protocol::management_channel::AsyncManagementActorError,
            >,
        >,
    ),
}
