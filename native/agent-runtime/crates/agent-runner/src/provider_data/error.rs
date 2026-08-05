use std::error::Error;
use std::fmt::{self, Display, Formatter};

use agent_protocol::frame::{AsyncEstablishedChannelError, InboundFrameError};

#[derive(Debug)]
pub enum ProviderDataError {
    Channel(AsyncEstablishedChannelError),
    Inbound(InboundFrameError),
    InvalidRequest(&'static str),
    Correlation(&'static str),
    UnexpectedPayload(&'static str),
    OperationAlreadyActive,
    NoActiveOperation,
    ForeignCommitReceipt,
    EventSequenceExhausted,
}

impl Display for ProviderDataError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Channel(error) => Display::fmt(error, formatter),
            Self::Inbound(error) => Display::fmt(error, formatter),
            Self::InvalidRequest(reason) => write!(formatter, "invalid provider request: {reason}"),
            Self::Correlation(reason) => write!(formatter, "provider correlation failed: {reason}"),
            Self::UnexpectedPayload(payload) => {
                write!(formatter, "unexpected provider payload: {payload}")
            }
            Self::OperationAlreadyActive => {
                formatter.write_str("provider operation already active")
            }
            Self::NoActiveOperation => formatter.write_str("provider operation is not active"),
            Self::ForeignCommitReceipt => formatter.write_str("provider commit receipt is foreign"),
            Self::EventSequenceExhausted => {
                formatter.write_str("provider event sequence exhausted")
            }
        }
    }
}

impl Error for ProviderDataError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Channel(error) => Some(error),
            Self::Inbound(error) => Some(error),
            _ => None,
        }
    }
}

impl From<AsyncEstablishedChannelError> for ProviderDataError {
    fn from(value: AsyncEstablishedChannelError) -> Self {
        Self::Channel(value)
    }
}

impl From<InboundFrameError> for ProviderDataError {
    fn from(value: InboundFrameError) -> Self {
        Self::Inbound(value)
    }
}
