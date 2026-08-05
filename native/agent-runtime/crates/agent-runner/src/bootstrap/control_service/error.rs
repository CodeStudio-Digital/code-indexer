use std::error::Error;
use std::fmt::{self, Debug, Display, Formatter};

use agent_platform::ipc::{ProtectedEndpointError, ProtectedEndpointFailure};
use agent_platform::windows::ipc::WindowsEndpointCleanup;
use agent_protocol::pulse_channel::RunnerPulseError;
use agent_protocol::runner_bootstrap::RunnerBootstrapError;

use crate::control::{AsyncControlDriverError, AsyncRunnerBootstrapError};
use crate::provider_context::ProviderContextError;

#[derive(Debug)]
pub enum RunnerControlServiceError {
    InvalidHostPeer(ProtectedEndpointError),
    InvalidSupervisorPeer(ProtectedEndpointError),
    Accept(ProtectedEndpointFailure<WindowsEndpointCleanup>),
    PulseAccept(ProtectedEndpointFailure<WindowsEndpointCleanup>),
    Pulse(RunnerPulseError),
    PulseAuthority(RunnerBootstrapError),
    ResourceSample(std::io::Error),
    PulsePumpStopped,
    Bootstrap(AsyncRunnerBootstrapError),
    Driver(AsyncControlDriverError),
    Hydration(Box<dyn Error + Send + Sync>),
    Cancelled,
    DeadlineElapsed,
    HydrationAlreadyConsumed,
    MissingContainmentAuthority,
    MissingHydrationOwnership,
    MissingExecutionSeed,
    MissingEffectAuthority,
    MissingProviderContext,
    ProviderContext(ProviderContextError),
    UnexpectedPreActiveTermination,
}

impl RunnerControlServiceError {
    pub(super) fn hydration(error: impl Error + Send + Sync + 'static) -> Self {
        Self::Hydration(Box::new(error))
    }
}

impl Display for RunnerControlServiceError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidHostPeer(error) | Self::InvalidSupervisorPeer(error) => {
                Display::fmt(error, formatter)
            }
            Self::Accept(error) | Self::PulseAccept(error) => {
                Display::fmt(error.error(), formatter)
            }
            Self::Pulse(error) => Display::fmt(error, formatter),
            Self::PulseAuthority(error) => Display::fmt(error, formatter),
            Self::ResourceSample(error) => {
                write!(formatter, "runner resource sample failed: {error}")
            }
            Self::PulsePumpStopped => formatter.write_str("runner pulse pump stopped"),
            Self::Bootstrap(error) => Display::fmt(error, formatter),
            Self::Driver(error) => Display::fmt(error, formatter),
            Self::Hydration(error) => write!(formatter, "attempt hydration failed: {error}"),
            Self::Cancelled => formatter.write_str("runner control activation was cancelled"),
            Self::DeadlineElapsed => {
                formatter.write_str("runner control activation deadline elapsed")
            }
            Self::HydrationAlreadyConsumed => {
                formatter.write_str("runner requested hydration more than once")
            }
            Self::MissingContainmentAuthority => {
                formatter.write_str("protected launch containment authority is missing")
            }
            Self::MissingHydrationOwnership => {
                formatter.write_str("runner activated without verified hydration ownership")
            }
            Self::MissingExecutionSeed => {
                formatter.write_str("runner activated without its validated execution seed")
            }
            Self::MissingEffectAuthority => {
                formatter.write_str("runner activated without live effect authority")
            }
            Self::MissingProviderContext => {
                formatter.write_str("runner activated without a composed provider context")
            }
            Self::ProviderContext(error) => Display::fmt(error, formatter),
            Self::UnexpectedPreActiveTermination => {
                formatter.write_str("runner accepted termination before activation")
            }
        }
    }
}

impl Error for RunnerControlServiceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidHostPeer(error) | Self::InvalidSupervisorPeer(error) => Some(error),
            Self::Accept(error) | Self::PulseAccept(error) => Some(error.error()),
            Self::Pulse(error) => Some(error),
            Self::PulseAuthority(error) => Some(error),
            Self::ResourceSample(error) => Some(error),
            Self::Bootstrap(error) => Some(error),
            Self::Driver(error) => Some(error),
            Self::Hydration(error) => Some(error.as_ref()),
            Self::ProviderContext(error) => Some(error),
            Self::Cancelled
            | Self::PulsePumpStopped
            | Self::DeadlineElapsed
            | Self::HydrationAlreadyConsumed
            | Self::MissingContainmentAuthority
            | Self::MissingHydrationOwnership
            | Self::MissingExecutionSeed
            | Self::MissingEffectAuthority
            | Self::MissingProviderContext
            | Self::UnexpectedPreActiveTermination => None,
        }
    }
}
