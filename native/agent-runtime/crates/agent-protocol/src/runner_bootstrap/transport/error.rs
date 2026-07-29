use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io;

use crate::framing::FramingError;

use super::super::RunnerBootstrapError;

#[derive(Debug)]
pub enum RunnerBootstrapTransportError {
    Framing(FramingError),
    Protocol(RunnerBootstrapError),
    UnexpectedEof(&'static str),
    TrailingFrame(&'static str),
    Flush(io::Error),
}

impl Display for RunnerBootstrapTransportError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Framing(error) => Display::fmt(error, formatter),
            Self::Protocol(error) => Display::fmt(error, formatter),
            Self::UnexpectedEof(message) => {
                write!(formatter, "{message} bootstrap frame is missing")
            }
            Self::TrailingFrame(message) => {
                write!(
                    formatter,
                    "{message} bootstrap stream contains a trailing frame"
                )
            }
            Self::Flush(error) => write!(formatter, "bootstrap transport flush failed: {error}"),
        }
    }
}

impl Error for RunnerBootstrapTransportError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Framing(error) => Some(error),
            Self::Protocol(error) => Some(error),
            Self::Flush(error) => Some(error),
            Self::UnexpectedEof(_) | Self::TrailingFrame(_) => None,
        }
    }
}

impl From<FramingError> for RunnerBootstrapTransportError {
    fn from(value: FramingError) -> Self {
        Self::Framing(value)
    }
}

impl From<RunnerBootstrapError> for RunnerBootstrapTransportError {
    fn from(value: RunnerBootstrapError) -> Self {
        Self::Protocol(value)
    }
}
