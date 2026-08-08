use std::fmt::{self, Debug, Formatter};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use agent_platform::ipc::{EndpointCancellation, ExpectedLocalPeer, ProtectedEndpointError};
use agent_platform::windows::ipc::VerifiedWindowsEndpointStream;
use agent_protocol::generated::v1 as wire;
use agent_protocol::runner_bootstrap::ShapeValidatedRunnerLaunchHandoff;
use tokio::time::Instant;

use crate::control::{ActiveRunnerCleanup, ActiveRunnerLifetime, ActiveRunnerLifetimeAdvance};
use crate::lifecycle::RunnerState;

use super::PreparedRunnerControlLaunch;

mod active_engine;
mod data;
mod drive;
mod error;
mod hydration;
mod pulse;

use data::PendingRunnerDataHydration;
use drive::PendingRunnerActivation;
pub use error::RunnerControlServiceError;
use hydration::VerifiedRunnerHydration;
use pulse::PendingRunnerPulse;
use pulse::{RunnerPulsePump, resource_sample};

type WindowsActiveLifetime =
    ActiveRunnerLifetime<VerifiedWindowsEndpointStream, ActiveRunnerResources>;
#[allow(
    dead_code,
    reason = "post-activation pump remains gated on productive dispatch authority"
)]
pub type ActiveRunnerControlAdvance =
    ActiveRunnerLifetimeAdvance<VerifiedWindowsEndpointStream, ActiveRunnerResources>;
pub type ActiveRunnerControlCleanup = ActiveRunnerCleanup<ActiveRunnerResources>;

/// Internal active owner retaining control, handoff, data, and pulse.
///
/// `advance` monitors one bounded event without treating idle as failure.
/// Production remains blocked on wire Cancel/Fence, pulse, effect dispatch,
/// and the supervisor reaper bridge.
pub struct ActiveRunnerControlLaunch {
    lifetime: WindowsActiveLifetime,
}

#[allow(
    dead_code,
    reason = "retained resources become observable only in the post-activation pump"
)]
pub struct ActiveRunnerResources {
    handoff: ShapeValidatedRunnerLaunchHandoff,
    runner_pulse: RunnerPulsePump,
    hydration: VerifiedRunnerHydration,
    engine_task: active_engine::ActiveEngineTask,
}

impl ActiveRunnerResources {
    async fn shutdown(self) {
        let Self { engine_task, .. } = self;
        engine_task.cancel_and_join().await;
    }
}

impl Debug for ActiveRunnerControlLaunch {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ActiveRunnerControlLaunch")
            .field("state", &self.lifetime.state())
            .field("handoff", &"[RETAINED; SECRETS REDACTED]")
            .field("remaining_listeners", &2)
            .finish_non_exhaustive()
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
                .advance_with_resource_sample(cancellation, heartbeat_resource_sample)
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

impl PreparedRunnerControlLaunch {
    /// Accepts exactly one expected Host and drives Hello→Prepare→Activate.
    ///
    /// PID verification occurs before protocol I/O; the endpoint token is then
    /// verified by `HostHello`. Any EOF, error, deadline, cancellation, or
    /// dropped future destroys the sole stream owner and cannot return Active.
    ///
    /// # Errors
    ///
    /// Returns a fail-closed error for peer, transport, handshake, hydration,
    /// lifecycle, deadline, or cancellation failure.
    pub(crate) async fn accept_and_activate(
        mut self,
        agent_hello_draft: wire::AgentHello,
        cancellation: &mut EndpointCancellation,
    ) -> Result<ActiveRunnerControlLaunch, RunnerControlServiceError> {
        let hard_deadline_at = self.pending.context.hard_deadline_at_unix_ms();
        let resource_budget = *self.pending.context.resource_budget();
        let effective_containment = self
            .handoff
            .metadata()
            .effective_containment
            .clone()
            .ok_or(RunnerControlServiceError::MissingContainmentAuthority)?;
        let physical_deadline = physical_deadline(hard_deadline_at)
            .map_err(RunnerControlServiceError::InvalidHostPeer)?;
        let host_process_id = self
            .handoff
            .metadata()
            .expected_host_peer
            .as_ref()
            .map_or(0, |peer| peer.process_id);
        let expected_host = ExpectedLocalPeer::new(host_process_id)
            .map_err(RunnerControlServiceError::InvalidHostPeer)?;
        let pending_data = PendingRunnerDataHydration::from_handoff(
            self.data,
            &mut self.handoff,
            expected_host,
            physical_deadline,
        )
        .map_err(RunnerControlServiceError::hydration)?;
        let pending_pulse = PendingRunnerPulse::from_handoff(
            self.runner_pulse,
            &mut self.handoff,
            physical_deadline,
        )?;
        let runner_pulse = pending_pulse.accept_and_probe(cancellation).await?;
        let stream = self
            .control
            .accept(expected_host, physical_deadline, cancellation)
            .await
            .map_err(RunnerControlServiceError::Accept)?;
        let driver = tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                return Err(RunnerControlServiceError::Cancelled);
            }
            result = self.pending.establish_async(
                stream,
                agent_hello_draft,
                physical_deadline,
            ) => result.map_err(RunnerControlServiceError::Bootstrap)?,
        };
        Box::pin(drive::pre_active(
            driver,
            cancellation,
            PendingRunnerActivation::new(
                self.handoff,
                pending_data,
                runner_pulse,
                resource_budget,
                effective_containment,
            ),
        ))
        .await
    }
}

fn physical_deadline(deadline_at_unix_ms: i64) -> Result<Instant, ProtectedEndpointError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ProtectedEndpointError::InvalidAddress("system clock before Unix epoch"))?;
    let now = i64::try_from(now.as_millis())
        .map_err(|_| ProtectedEndpointError::InvalidAddress("system clock overflow"))?;
    if now >= deadline_at_unix_ms {
        return Err(ProtectedEndpointError::DeadlineElapsed);
    }
    let remaining = u64::try_from(deadline_at_unix_ms - now)
        .map_err(|_| ProtectedEndpointError::DeadlineElapsed)?;
    Instant::now()
        .checked_add(Duration::from_millis(remaining))
        .ok_or(ProtectedEndpointError::DeadlineElapsed)
}
