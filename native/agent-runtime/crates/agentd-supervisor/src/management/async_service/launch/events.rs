use agent_platform::containment::{ContainmentPort, SpawnResult};

use crate::management::driver::{
    AsyncLaunchPrepareOutcome, AsyncLaunchSpawnOutcome, AsyncWorkerCompletion,
    PhysicalLaunchWorkerCommand, PhysicalLaunchWorkerEvent,
};
use crate::management::{
    ProtectedLaunchProvisionPort, SupervisorDriverError, SupervisorLifecycleClock,
    SupervisorOnlineLifecycleTimer,
};

use super::{PendingLaunchPhase, PendingServiceLaunch};
use crate::management::{SupervisorAsyncService, SupervisorAsyncServiceAdvance};

impl<P, V, C, T> SupervisorAsyncService<P, V, C, T>
where
    P: ContainmentPort + Send + Sync + 'static,
    P::Group: Send + 'static,
    V: ProtectedLaunchProvisionPort + Send + Sync + 'static,
    C: SupervisorLifecycleClock,
    T: SupervisorOnlineLifecycleTimer,
{
    pub(super) async fn apply_launch_event(
        &mut self,
        event: PhysicalLaunchWorkerEvent<P::Group>,
    ) -> Option<SupervisorAsyncServiceAdvance<P::Error>> {
        let pending = self.pending_launch.take().expect("pending launch");
        match event {
            PhysicalLaunchWorkerEvent::Prepared(prepared) => {
                self.apply_prepared_event(pending, prepared).await
            }
            PhysicalLaunchWorkerEvent::Spawned(spawned) => {
                self.apply_spawned_event(pending, spawned).await
            }
            PhysicalLaunchWorkerEvent::Completed(receipt) => {
                self.apply_completed_event(pending, receipt).await
            }
            PhysicalLaunchWorkerEvent::CompletionCleanupRequired => {
                self.apply_completion_cleanup_event(pending).await
            }
            PhysicalLaunchWorkerEvent::Stopped => self.apply_stopped_event(pending).await,
        }
    }

    async fn apply_prepared_event(
        &mut self,
        mut pending: PendingServiceLaunch<P, V>,
        prepared: bool,
    ) -> Option<SupervisorAsyncServiceAdvance<P::Error>> {
        let outcome = {
            let (owner, clock) = self.lifecycle.owner_and_clock_mut();
            owner.finish_async_prepare(&mut pending.state, prepared, clock)
        };
        match outcome {
            Ok(AsyncLaunchPrepareOutcome::Spawn) => {
                if pending
                    .send_command(PhysicalLaunchWorkerCommand::Spawn)
                    .is_err()
                {
                    return Some(self.fail_owned_worker_loss(pending));
                }
                pending.phase = PendingLaunchPhase::Spawning;
                self.pending_launch = Some(pending);
                None
            }
            Ok(AsyncLaunchPrepareOutcome::Resolve(emission)) => {
                Some(self.finish_launch_response(pending, emission).await)
            }
            Ok(AsyncLaunchPrepareOutcome::Stop(result)) => self
                .stop_pending_launch(pending, result.map_err(SupervisorDriverError::CleanupState)),
            Err(error) if prepared => self.stop_pending_launch(pending, Err(error)),
            Err(error) => Some(self.finish_joined_error(pending, error)),
        }
    }

    async fn apply_spawned_event(
        &mut self,
        mut pending: PendingServiceLaunch<P, V>,
        spawned: SpawnResult<P::Group, ()>,
    ) -> Option<SupervisorAsyncServiceAdvance<P::Error>> {
        let worker_waits = spawned.is_ok();
        let outcome = {
            let (owner, clock) = self.lifecycle.owner_and_clock_mut();
            owner.finish_async_spawn(&mut pending.state, spawned, clock)
        };
        match outcome {
            Ok(AsyncLaunchSpawnOutcome::Complete(physical)) => {
                if pending
                    .send_command(PhysicalLaunchWorkerCommand::Complete(physical))
                    .is_err()
                {
                    return Some(self.fail_owned_worker_loss(pending));
                }
                pending.phase = PendingLaunchPhase::Completing;
                self.pending_launch = Some(pending);
                None
            }
            Ok(AsyncLaunchSpawnOutcome::Resolve(emission)) => {
                Some(self.finish_launch_response(pending, emission).await)
            }
            Ok(AsyncLaunchSpawnOutcome::Stop(result)) => self
                .stop_pending_launch(pending, result.map_err(SupervisorDriverError::CleanupState)),
            Err(error) if worker_waits => self.stop_pending_launch(pending, Err(error)),
            Err(error) => Some(self.finish_joined_error(pending, error)),
        }
    }

    async fn apply_completed_event(
        &mut self,
        mut pending: PendingServiceLaunch<P, V>,
        receipt: Box<crate::management::driver::ProtectedLaunchReceipt>,
    ) -> Option<SupervisorAsyncServiceAdvance<P::Error>> {
        if pending.join_worker().is_err() {
            return Some(self.fail_owned_worker_loss(pending));
        }
        let outcome = {
            let (owner, clock) = self.lifecycle.owner_and_clock_mut();
            owner.finish_async_completion(
                &mut pending.state,
                AsyncWorkerCompletion::Completed(receipt),
                clock,
            )
        };
        Some(match outcome {
            Ok(emission) => self.finish_launch_response(pending, emission).await,
            Err(error) => self.fail_owned_launch(pending, error),
        })
    }

    async fn apply_completion_cleanup_event(
        &mut self,
        mut pending: PendingServiceLaunch<P, V>,
    ) -> Option<SupervisorAsyncServiceAdvance<P::Error>> {
        let cleanup = pending
            .worker
            .take()
            .expect("cleanup worker")
            .into_cleanup_owner();
        let outcome = {
            let (owner, clock) = self.lifecycle.owner_and_clock_mut();
            owner.finish_async_completion(
                &mut pending.state,
                AsyncWorkerCompletion::CleanupRequired(cleanup),
                clock,
            )
        };
        Some(match outcome {
            Ok(emission) => self.finish_launch_response(pending, emission).await,
            Err(error) => self.fail_owned_launch(pending, error),
        })
    }

    async fn apply_stopped_event(
        &mut self,
        mut pending: PendingServiceLaunch<P, V>,
    ) -> Option<SupervisorAsyncServiceAdvance<P::Error>> {
        if pending.join_worker().is_err() {
            return Some(self.fail_owned_worker_loss(pending));
        }
        let finalized = self
            .lifecycle
            .owner_mut()
            .finish_stopped_async_launch(&pending.state);
        let result = pending.stop_result.take().expect("stopped launch result");
        Some(match finalized {
            Err(error) => self.fail_owned_launch(pending, error),
            Ok(()) => match result {
                Ok(emission) => self.finish_launch_response(pending, emission).await,
                Err(error) => self.fail_owned_launch(pending, error),
            },
        })
    }

    fn finish_joined_error(
        &mut self,
        mut pending: PendingServiceLaunch<P, V>,
        error: SupervisorDriverError<P::Error>,
    ) -> SupervisorAsyncServiceAdvance<P::Error> {
        if pending.join_worker().is_err() {
            self.fail_owned_worker_loss(pending)
        } else {
            self.fail_owned_launch(pending, error)
        }
    }
}
