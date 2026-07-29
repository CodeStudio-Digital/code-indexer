use std::error::Error;
use std::fmt::{self, Display, Formatter};

use agent_platform::ipc::ProtectedEndpointError;

use crate::HostEndpointKind;

#[derive(Debug)]
pub enum HostBridgeError {
    EmptyRequest,
    RequestTooLarge {
        length: usize,
        maximum: usize,
    },
    MalformedRequest(prost::DecodeError),
    InvalidRequest(&'static str),
    ClockUnavailable,
    ClockRegressed,
    DeadlineElapsed,
    UnsupportedPlatform,
    Endpoint {
        kind: HostEndpointKind,
        source: ProtectedEndpointError,
    },
}

impl Display for HostBridgeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyRequest => formatter.write_str("Host bridge request is empty"),
            Self::RequestTooLarge { length, maximum } => {
                write!(
                    formatter,
                    "Host bridge request length {length} exceeds {maximum}"
                )
            }
            Self::MalformedRequest(_) => formatter.write_str("Host bridge request is malformed"),
            Self::InvalidRequest(field) => {
                write!(formatter, "Host bridge request has invalid {field}")
            }
            Self::ClockUnavailable => formatter.write_str("Host bridge clock is unavailable"),
            Self::ClockRegressed => formatter.write_str("Host bridge clock regressed"),
            Self::DeadlineElapsed => formatter.write_str("Host bridge deadline elapsed"),
            Self::UnsupportedPlatform => {
                formatter.write_str("Host bridge platform is not implemented")
            }
            Self::Endpoint { kind, .. } => {
                write!(formatter, "{kind:?} endpoint authentication failed")
            }
        }
    }
}

impl Error for HostBridgeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::MalformedRequest(source) => Some(source),
            Self::Endpoint { source, .. } => Some(source),
            _ => None,
        }
    }
}
