use std::error::Error;
use std::fmt::{self, Display, Formatter};

use crate::frame::{InboundFrameError, OutboundFrameError};
use crate::framing::AsyncFramingError;

#[derive(Debug)]
pub enum AsyncEstablishedChannelError {
    PhysicalCapMismatch { physical: u32, negotiated: usize },
    Framing(AsyncFramingError),
    Inbound(InboundFrameError),
    Outbound(OutboundFrameError),
}

impl Display for AsyncEstablishedChannelError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::PhysicalCapMismatch {
                physical,
                negotiated,
            } => write!(
                formatter,
                "physical frame cap {physical} does not equal negotiated cap {negotiated}"
            ),
            Self::Framing(error) => Display::fmt(error, formatter),
            Self::Inbound(error) => Display::fmt(error, formatter),
            Self::Outbound(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for AsyncEstablishedChannelError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Framing(error) => Some(error),
            Self::Inbound(error) => Some(error),
            Self::Outbound(error) => Some(error),
            Self::PhysicalCapMismatch { .. } => None,
        }
    }
}
