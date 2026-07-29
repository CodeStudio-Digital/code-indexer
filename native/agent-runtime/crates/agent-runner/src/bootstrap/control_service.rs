use std::fmt::{self, Debug, Formatter};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use agent_platform::ipc::{EndpointCancellation, ExpectedLocalPeer, ProtectedEndpointError};
use agent_platform::windows::ipc::{VerifiedWindowsEndpointStream, WindowsProtectedEndpoint};
use agent_protocol::frame::AsyncEstablishedAttemptChannel;
use agent_protocol::generated::v1 as wire;
use agent_protocol::runner_bootstrap::ShapeValidatedRunnerLaunchHandoff;
use tokio::time::Instant;

use crate::control::{ActiveRunnerCleanup, ActiveRunnerLifetime, ActiveRunnerLifetimeAdvance};
use crate::lifecycle::RunnerState;

use super::PreparedRunnerControlLaunch;

mod data;
mod drive;
mod error;
mod hydration;

use data::PendingRunnerDataHydration;
use drive::PendingRunnerActivation;
pub use error::RunnerControlServiceError;
use hydration::VerifiedRunnerHydration;

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
    data: AsyncEstablishedAttemptChannel<VerifiedWindowsEndpointStream>,
    runner_pulse: WindowsProtectedEndpoint,
    hydration: VerifiedRunnerHydration,
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
        self.lifetime.advance(cancellation)
    }

    /// Revokes locally; the returned owner still requires supervisor reap.
    pub fn revoke(self) -> ActiveRunnerControlCleanup {
        self.lifetime.revoke()
    }
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
                self.runner_pulse,
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
