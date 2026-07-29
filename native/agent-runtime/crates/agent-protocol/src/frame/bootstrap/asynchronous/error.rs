use std::error::Error;
use std::fmt::{self, Display, Formatter};

use crate::frame::{
    AsyncEstablishedChannelError, BootstrapError, InboundFrameError, OutboundFrameError,
};
use crate::framing::AsyncFramingError;

#[derive(Debug)]
pub enum AsyncBootstrapChannelError {
    MissingOutboundHello,
    SeedChannelMismatch,
    Framing(AsyncFramingError),
    Bootstrap(BootstrapError),
    Outbound(OutboundFrameError),
    Handoff(InboundFrameError),
    Established(AsyncEstablishedChannelError),
}

impl Display for AsyncBootstrapChannelError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingOutboundHello => {
                formatter.write_str("bootstrap handoff requires a committed outbound Hello")
            }
            Self::SeedChannelMismatch => {
                formatter.write_str("negotiated seed belongs to a different bootstrap channel")
            }
            Self::Framing(error) => Display::fmt(error, formatter),
            Self::Bootstrap(error) => Display::fmt(error, formatter),
            Self::Outbound(error) => Display::fmt(error, formatter),
            Self::Handoff(error) => Display::fmt(error, formatter),
            Self::Established(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for AsyncBootstrapChannelError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Framing(error) => Some(error),
            Self::Bootstrap(error) => Some(error),
            Self::Outbound(error) => Some(error),
            Self::Handoff(error) => Some(error),
            Self::Established(error) => Some(error),
            Self::MissingOutboundHello | Self::SeedChannelMismatch => None,
        }
    }
}

impl From<BootstrapError> for AsyncBootstrapChannelError {
    fn from(value: BootstrapError) -> Self {
        Self::Bootstrap(value)
    }
}
