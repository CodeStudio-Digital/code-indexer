use std::error::Error;
use std::fmt::{self, Display, Formatter};

use agent_protocol::frame::{AsyncEstablishedChannelError, InboundFrameError};

use super::super::HydrationTransportError;

#[derive(Debug)]
pub(in crate::bootstrap::control_service) enum HydrationDataPumpError {
    InvalidContext,
    DeadlineElapsed,
    UnexpectedPayload,
    Inbound(InboundFrameError),
    Channel(AsyncEstablishedChannelError),
    Transport(HydrationTransportError),
}

impl Display for HydrationDataPumpError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidContext => formatter.write_str("hydration pump context is invalid"),
            Self::DeadlineElapsed => formatter.write_str("hydration hard deadline elapsed"),
            Self::UnexpectedPayload => {
                formatter.write_str("hydration payload is out of order or unsupported")
            }
            Self::Inbound(error) => Display::fmt(error, formatter),
            Self::Channel(error) => Display::fmt(error, formatter),
            Self::Transport(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for HydrationDataPumpError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Inbound(error) => Some(error),
            Self::Channel(error) => Some(error),
            Self::Transport(error) => Some(error),
            Self::InvalidContext | Self::DeadlineElapsed | Self::UnexpectedPayload => None,
        }
    }
}

impl From<InboundFrameError> for HydrationDataPumpError {
    fn from(value: InboundFrameError) -> Self {
        Self::Inbound(value)
    }
}

impl From<AsyncEstablishedChannelError> for HydrationDataPumpError {
    fn from(value: AsyncEstablishedChannelError) -> Self {
        Self::Channel(value)
    }
}

impl From<HydrationTransportError> for HydrationDataPumpError {
    fn from(value: HydrationTransportError) -> Self {
        Self::Transport(value)
    }
}
