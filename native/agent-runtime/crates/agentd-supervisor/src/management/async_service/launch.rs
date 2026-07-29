use agent_platform::containment::ContainmentPort;

use crate::management::driver::{
    PhysicalLaunchWorkerCommand, PhysicalLaunchWorkerEvent, PreparedLaunchEmission,
};
use crate::management::{
    OnlineLifecycleAdvance, ProtectedLaunchProvisionPort, SupervisorDriverError,
    SupervisorLifecycleClock, SupervisorOnlineLifecycleTimer,
};

use super::{ServiceMode, SupervisorAsyncService, SupervisorAsyncServiceAdvance};

mod events;
mod state;

pub(super) use state::{PendingLaunchPhase, PendingServiceLaunch};

enum LaunchWake<G> {
    Lifecycle(OnlineLifecycleAdvance),
    Worker(Option<PhysicalLaunchWorkerEvent<G>>),
}

impl<P, V, C, T> SupervisorAsyncService<P, V, C, T>
where
    P: ContainmentPort + Send + Sync + 'static,
    P::Group: Send + 'static,
    V: ProtectedLaunchProvisionPort + Send + Sync + 'static,
    C: SupervisorLifecycleClock,
    T: SupervisorOnlineLifecycleTimer,
{
    pub(super) async fn resume_pending_launch(
        &mut self,
    ) -> SupervisorAsyncServiceAdvance<P::Error> {
        loop {
            let wake = {
                let pending = self.pending_launch.as_mut().expect("pending launch");
                let worker = pending.worker.as_mut().expect("launch worker");
                if matches!(self.mode, ServiceMode::HardRestart(_)) {
                    LaunchWake::Worker(worker.next().await)
                } else {
                    tokio::select! {
                        biased;
                        lifecycle = self.lifecycle.advance() => LaunchWake::Lifecycle(lifecycle),
                        event = worker.next() => LaunchWake::Worker(event),
                    }
                }
            };
            match wake {
                LaunchWake::Lifecycle(outcome) => return self.apply_lifecycle(outcome),
                LaunchWake::Worker(Some(event)) => {
                    if let Some(step) = self.apply_launch_event(event).await {
                        return step;
                    }
                }
                LaunchWake::Worker(None) => return self.fail_lost_launch_worker(),
            }
        }
    }

    fn stop_pending_launch(
        &mut self,
        mut pending: PendingServiceLaunch<P, V>,
        result: Result<PreparedLaunchEmission, SupervisorDriverError<P::Error>>,
    ) -> Option<SupervisorAsyncServiceAdvance<P::Error>> {
        if pending
            .send_command(PhysicalLaunchWorkerCommand::Stop)
            .is_err()
        {
            return Some(self.fail_owned_worker_loss(pending));
        }
        pending.phase = PendingLaunchPhase::Stopping;
        pending.stop_result = Some(result);
        self.pending_launch = Some(pending);
        None
    }

    async fn finish_launch_response(
        &mut self,
        mut pending: PendingServiceLaunch<P, V>,
        emission: PreparedLaunchEmission,
    ) -> SupervisorAsyncServiceAdvance<P::Error> {
        if pending.worker.is_some() && pending.join_worker().is_err() {
            return self.fail_owned_worker_loss(pending);
        }
        let inbound = pending.inbound.take().expect("launch inbound");
        self.queue_launch_response(inbound, emission).await
    }

    fn fail_owned_launch(
        &mut self,
        mut pending: PendingServiceLaunch<P, V>,
        error: SupervisorDriverError<P::Error>,
    ) -> SupervisorAsyncServiceAdvance<P::Error> {
        let key = pending.state.ownership_key();
        if let Some(inbound) = pending.inbound.take() {
            let _ = inbound.reject();
        }
        self.fail_driver(error, Some(key))
    }

    fn fail_owned_worker_loss(
        &mut self,
        pending: PendingServiceLaunch<P, V>,
    ) -> SupervisorAsyncServiceAdvance<P::Error> {
        self.fail_owned_launch(
            pending,
            SupervisorDriverError::CleanupState(
                crate::management::CleanupStateError::InvalidTransition,
            ),
        )
    }

    fn fail_lost_launch_worker(&mut self) -> SupervisorAsyncServiceAdvance<P::Error> {
        let mut pending = self.pending_launch.take().expect("pending launch");
        let _ = pending.join_worker();
        self.fail_owned_worker_loss(pending)
    }
}
