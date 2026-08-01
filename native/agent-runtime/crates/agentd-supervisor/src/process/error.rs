use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io;

use agent_platform::ipc::ProtectedEndpointError;
use agent_protocol::management_channel::AsyncManagementActorError;
use agent_protocol::supervisor_bootstrap::SupervisorBootstrapError;

use crate::management::{
    CleanupStateError, ProtectedLaunchPeerAuthorityError, SupervisorDriverCreateError,
    SupervisorLifecycleClockError, SupervisorManagementTerminal, TrustedRunnerConfigError,
    WindowsProtectedLaunchError,
};

#[derive(Debug)]
pub enum SupervisorProcessError {
    Runtime(io::Error),
    BootstrapOpen(io::Error),
    Bootstrap(SupervisorBootstrapError),
    Endpoint(ProtectedEndpointError),
    Management(AsyncManagementActorError),
    Configuration(TrustedRunnerConfigError),
    PeerAuthority(ProtectedLaunchPeerAuthorityError),
    Provisioner(WindowsProtectedLaunchError),
    Driver(SupervisorDriverCreateError),
    Clock(SupervisorLifecycleClockError),
    HardRestart(CleanupStateError),
    Terminal(SupervisorManagementTerminal),
}

impl Display for SupervisorProcessError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::Runtime(_) => "cannot create supervisor runtime",
            Self::BootstrapOpen(_) => "protected supervisor bootstrap is unavailable",
            Self::Bootstrap(_) => "protected supervisor bootstrap failed",
            Self::Endpoint(_) => "protected management endpoint failed",
            Self::Management(_) => "management bootstrap failed",
            Self::Configuration(_) => "trusted runner configuration is invalid",
            Self::PeerAuthority(_) => "physical peer authority is invalid",
            Self::Provisioner(_) => "runner pulse provisioner is unavailable",
            Self::Driver(_) => "supervisor lifecycle core creation failed",
            Self::Clock(_) => "supervisor lifecycle clock is invalid",
            Self::HardRestart(_) => "supervisor requires a hard restart",
            Self::Terminal(_) => "management channel terminated fail-closed",
        };
        formatter.write_str(message)
    }
}

impl Error for SupervisorProcessError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Runtime(error) | Self::BootstrapOpen(error) => Some(error),
            Self::Bootstrap(error) => Some(error),
            Self::Endpoint(error) => Some(error),
            Self::Management(error) => Some(error),
            Self::Configuration(_)
            | Self::PeerAuthority(_)
            | Self::Provisioner(_)
            | Self::Driver(_)
            | Self::HardRestart(_)
            | Self::Terminal(_) => None,
            Self::Clock(error) => Some(error),
        }
    }
}
