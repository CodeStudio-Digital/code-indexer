use agent_platform::ipc::EndpointCancellation;
use agent_protocol::generated::v1 as wire;

use crate::control::ActiveRunnerLifetimeAdvance;
use crate::lifecycle::RunnerState;

use super::pulse::resource_sample;
use super::{
    ActiveRunnerControlAdvance, ActiveRunnerControlCleanup, ActiveRunnerControlLaunch,
    ActiveRunnerResources,
};
impl ActiveRunnerResources {
    async fn shutdown(self) {
        let Self { engine_task, .. } = self;
        engine_task.cancel_and_join().await;
    }
}

#[allow(
    dead_code,
    reason = "post-activation inspection awaits productive dispatch authority"
)]
impl ActiveRunnerControlLaunch {
    #[must_use]
    pub const fn state(&self) -> RunnerState {
        self.lifetime.state()
    }

    #[must_use]
    pub const fn is_control_closed(&self) -> bool {
        self.lifetime.is_control_closed()
    }

    pub fn advance(
        self,
        cancellation: &mut EndpointCancellation,
    ) -> impl Future<Output = ActiveRunnerControlAdvance> + '_ {
        self.lifetime
            .advance_with_resource_sample(cancellation, heartbeat_resource_sample)
    }

    /// Owns the active attempt until a terminal control, deadline, local
    /// cancellation, transport failure, or supervisor reap ends its lifetime.
    pub(crate) async fn run_until_cleanup(mut self, cancellation: &mut EndpointCancellation) {
        // Give the engine one bounded scheduling turn and prove that its first
        // provider request is physically committed. Provider response/model
        // latency remains concurrent with the always-responsive Control loop.
        if !self
            .lifetime
            .resources_mut()
            .engine_task
            .wait_started()
            .await
        {
            let cleanup = self.lifetime.revoke();
            cleanup.into_resources().shutdown().await;
            return;
        }
        loop {
            if self.lifetime.resources_mut().engine_task.is_finished() {
                let cleanup = self.lifetime.revoke();
                cleanup.into_resources().shutdown().await;
                return;
            }
            match self
                .lifetime
                .advance_with_settlement(
                    cancellation,
                    heartbeat_resource_sample,
                    Some(settle_active_engine),
                )
                .await
            {
                ActiveRunnerLifetimeAdvance::Continue(next) => {
                    self.lifetime = next;
                }
                ActiveRunnerLifetimeAdvance::CleanupRequired(cleanup) => {
                    let resources = cleanup.into_resources();
                    resources.shutdown().await;
                    return;
                }
            }
        }
    }

    /// Revokes locally; the returned owner still requires supervisor reap.
    pub fn revoke(self) -> ActiveRunnerControlCleanup {
        self.lifetime.revoke()
    }
}

fn heartbeat_resource_sample()
-> Result<wire::ResourceSample, crate::control::AsyncControlDriverError> {
    resource_sample()
        .map_err(|_| crate::control::AsyncControlDriverError::HeartbeatResourceSampleFailed)
}

fn settle_active_engine(
    resources: &mut ActiveRunnerResources,
) -> std::pin::Pin<Box<dyn Future<Output = ()> + Send + '_>> {
    Box::pin(resources.engine_task.wait_settled())
}
