use std::error::Error;
use std::fmt::{self, Display, Formatter};

use prost::DecodeError;

use crate::provider_data::ProviderDataError;

#[derive(Debug)]
pub enum ProviderGatewayError {
    Data(ProviderDataError),
    DecodeContext(DecodeError),
    InvalidAuthority,
    InvalidContext,
    NonCanonicalContext,
    InvalidProviderEvent(&'static str),
}

impl Display for ProviderGatewayError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Data(error) => Display::fmt(error, formatter),
            Self::DecodeContext(_) => formatter.write_str("provider context cannot be decoded"),
            Self::InvalidAuthority => formatter.write_str("provider authority is incomplete"),
            Self::InvalidContext => formatter.write_str("provider context exceeds its bounds"),
            Self::NonCanonicalContext => {
                formatter.write_str("provider context is not canonical protobuf")
            }
            Self::InvalidProviderEvent(reason) => {
                write!(
                    formatter,
                    "provider event cannot enter the engine: {reason}"
                )
            }
        }
    }
}

impl Error for ProviderGatewayError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Data(error) => Some(error),
            Self::DecodeContext(error) => Some(error),
            _ => None,
        }
    }
}
