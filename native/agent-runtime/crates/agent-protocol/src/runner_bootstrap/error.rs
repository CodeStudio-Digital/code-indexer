use std::error::Error;
use std::fmt::{self, Display, Formatter};

use crate::wire_identity::WireIdentityError;

#[derive(Debug)]
pub enum RunnerBootstrapError {
    EmptyMessage(&'static str),
    MessageTooLarge {
        message: &'static str,
        length: usize,
        maximum: usize,
    },
    MalformedMessage {
        message: &'static str,
        source: prost::DecodeError,
    },
    InvalidIdentity(WireIdentityError),
    InvalidField {
        message: &'static str,
        field: &'static str,
    },
    ReadyMismatch(&'static str),
}

impl Display for RunnerBootstrapError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyMessage(message) => write!(formatter, "{message} cannot be empty"),
            Self::MessageTooLarge {
                message,
                length,
                maximum,
            } => write!(
                formatter,
                "{message} has {length} bytes; hard cap is {maximum}"
            ),
            Self::MalformedMessage { message, source } => {
                write!(formatter, "malformed {message}: {source}")
            }
            Self::InvalidIdentity(source) => {
                write!(formatter, "invalid runner bootstrap identity: {source}")
            }
            Self::InvalidField { message, field } => {
                write!(formatter, "{message} field {field} is invalid")
            }
            Self::ReadyMismatch(field) => {
                write!(formatter, "RunnerEndpointsReady does not match {field}")
            }
        }
    }
}

impl Error for RunnerBootstrapError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::MalformedMessage { source, .. } => Some(source),
            Self::InvalidIdentity(source) => Some(source),
            _ => None,
        }
    }
}

pub(super) const fn invalid(message: &'static str, field: &'static str) -> RunnerBootstrapError {
    RunnerBootstrapError::InvalidField { message, field }
}
