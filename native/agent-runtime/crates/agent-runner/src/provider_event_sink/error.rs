use std::error::Error;
use std::fmt::{self, Display, Formatter};

use crate::provider_data::ProviderDataError;

#[derive(Debug)]
pub enum ProviderEventSinkError {
    Data(ProviderDataError),
    InvalidAuthority(&'static str),
    TerminalAlreadyCommitted,
    SequenceExhausted,
}

impl Display for ProviderEventSinkError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Data(error) => Display::fmt(error, formatter),
            Self::InvalidAuthority(field) => {
                write!(
                    formatter,
                    "provider event sink authority is invalid: {field}"
                )
            }
            Self::TerminalAlreadyCommitted => {
                formatter.write_str("provider event sink terminal is already committed")
            }
            Self::SequenceExhausted => {
                formatter.write_str("provider event sink sequence is exhausted")
            }
        }
    }
}

impl Error for ProviderEventSinkError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Data(error) => Some(error),
            _ => None,
        }
    }
}

impl From<ProviderDataError> for ProviderEventSinkError {
    fn from(value: ProviderDataError) -> Self {
        Self::Data(value)
    }
}
