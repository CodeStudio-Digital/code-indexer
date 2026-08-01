use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::time::{SystemTime, UNIX_EPOCH};

use agent_platform::ipc::ProtectedEndpointError;
use agent_protocol::pulse_channel::RunnerPulseError;
use agent_protocol::runner_bootstrap::RunnerBootstrapTransportError;

#[derive(Debug)]
pub enum WindowsProtectedLaunchError {
    InvalidStartupTimeout,
    InvalidPulseTimeout,
    BootstrapPrepare,
    ChildHandleAllowlist,
    CancellationBusy,
    CancellationState,
    Clock,
    EffectiveDeadline,
    Handoff,
    HandoffSend(RunnerBootstrapTransportError),
    ReadyReceive(RunnerBootstrapTransportError),
    PulseAuthority,
    PulseEndpoint(ProtectedEndpointError),
    PulseRuntime(std::io::Error),
    Pulse(RunnerPulseError),
    PulsePhase,
    AuthorityExpired,
    CleanupPending,
    InvalidState,
}

impl Display for WindowsProtectedLaunchError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "protected Windows runner bootstrap failed: {self:?}"
        )
    }
}

impl Error for WindowsProtectedLaunchError {}

pub(super) fn now_unix_ms() -> Result<i64, WindowsProtectedLaunchError> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| WindowsProtectedLaunchError::Clock)?;
    i64::try_from(elapsed.as_millis()).map_err(|_| WindowsProtectedLaunchError::Clock)
}
