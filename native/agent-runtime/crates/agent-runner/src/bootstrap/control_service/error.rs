use std::error::Error;
use std::fmt::{self, Debug, Display, Formatter};

use agent_platform::ipc::{ProtectedEndpointError, ProtectedEndpointFailure};
use agent_platform::windows::ipc::WindowsEndpointCleanup;

use crate::control::{AsyncControlDriverError, AsyncRunnerBootstrapError};

#[derive(Debug)]
pub enum RunnerControlServiceError {
    InvalidHostPeer(ProtectedEndpointError),
    Accept(ProtectedEndpointFailure<WindowsEndpointCleanup>),
    Bootstrap(AsyncRunnerBootstrapError),
    Driver(AsyncControlDriverError),
    Hydration(Box<dyn Error + Send + Sync>),
    Cancelled,
    DeadlineElapsed,
    HydrationAlreadyConsumed,
    MissingContainmentAuthority,
    MissingHydrationOwnership,
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
            Self::InvalidHostPeer(error) => Display::fmt(error, formatter),
            Self::Accept(error) => Display::fmt(error.error(), formatter),
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
            Self::UnexpectedPreActiveTermination => {
                formatter.write_str("runner accepted termination before activation")
            }
        }
    }
}

impl Error for RunnerControlServiceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidHostPeer(error) => Some(error),
            Self::Accept(error) => Some(error.error()),
            Self::Bootstrap(error) => Some(error),
            Self::Driver(error) => Some(error),
            Self::Hydration(error) => Some(error.as_ref()),
            Self::Cancelled
            | Self::DeadlineElapsed
            | Self::HydrationAlreadyConsumed
            | Self::MissingContainmentAuthority
            | Self::MissingHydrationOwnership
            | Self::UnexpectedPreActiveTermination => None,
        }
    }
}
