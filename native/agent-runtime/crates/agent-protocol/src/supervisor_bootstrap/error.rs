use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io;

use crate::framing::FramingError;
use crate::identity::EmptyIdentifier;

#[derive(Debug)]
pub enum SupervisorBootstrapError {
    Framing(FramingError),
    InvalidConnectionId(EmptyIdentifier),
    InvalidField(&'static str),
    UnexpectedEof,
    TrailingBytes,
    Flush(io::Error),
}

impl Display for SupervisorBootstrapError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Framing(error) => Display::fmt(error, formatter),
            Self::InvalidConnectionId(_) => {
                formatter.write_str("supervisor bootstrap connection ID is invalid")
            }
            Self::InvalidField(field) => {
                write!(formatter, "supervisor bootstrap field {field} is invalid")
            }
            Self::UnexpectedEof => formatter.write_str("supervisor bootstrap handoff is missing"),
            Self::TrailingBytes => {
                formatter.write_str("supervisor bootstrap contains bytes after the handoff")
            }
            Self::Flush(error) => write!(formatter, "supervisor Ready flush failed: {error}"),
        }
    }
}

impl Error for SupervisorBootstrapError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Framing(error) => Some(error),
            Self::InvalidConnectionId(error) => Some(error),
            Self::Flush(error) => Some(error),
            Self::InvalidField(_) | Self::UnexpectedEof | Self::TrailingBytes => None,
        }
    }
}

impl From<FramingError> for SupervisorBootstrapError {
    fn from(value: FramingError) -> Self {
        Self::Framing(value)
    }
}
