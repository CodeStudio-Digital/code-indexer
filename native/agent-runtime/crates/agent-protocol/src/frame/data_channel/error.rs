use std::error::Error;
use std::fmt::{self, Display, Formatter};

use crate::frame::AsyncEstablishedChannelError;
use crate::framing::AsyncFramingError;

#[derive(Debug)]
pub enum DataChannelError {
    InvalidAuthority(&'static str),
    InvalidLimits(&'static str),
    InvalidBinding(&'static str),
    UnexpectedReplay,
    Established(AsyncEstablishedChannelError),
    Framing(AsyncFramingError),
}

impl Display for DataChannelError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidAuthority(reason) => {
                write!(formatter, "data bind authority is invalid: {reason}")
            }
            Self::InvalidLimits(reason) => {
                write!(formatter, "data channel limits are invalid: {reason}")
            }
            Self::InvalidBinding(reason) => {
                write!(formatter, "data endpoint binding is invalid: {reason}")
            }
            Self::UnexpectedReplay => {
                formatter.write_str("the initial data binding cannot be a replay")
            }
            Self::Established(error) => Display::fmt(error, formatter),
            Self::Framing(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for DataChannelError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Established(error) => Some(error),
            Self::Framing(error) => Some(error),
            Self::InvalidAuthority(_)
            | Self::InvalidLimits(_)
            | Self::InvalidBinding(_)
            | Self::UnexpectedReplay => None,
        }
    }
}

impl From<AsyncEstablishedChannelError> for DataChannelError {
    fn from(value: AsyncEstablishedChannelError) -> Self {
        Self::Established(value)
    }
}

impl From<AsyncFramingError> for DataChannelError {
    fn from(value: AsyncFramingError) -> Self {
        Self::Framing(value)
    }
}
