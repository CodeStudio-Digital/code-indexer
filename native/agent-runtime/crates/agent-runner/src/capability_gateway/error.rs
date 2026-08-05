use std::error::Error;
use std::fmt::{self, Display, Formatter};

use agent_tools::capability::InvocationValidationError;

use crate::provider_data::ProviderDataError;

#[derive(Debug)]
pub enum CapabilityGatewayError {
    InvalidInvocation(InvocationValidationError),
    AuthorityMismatch,
    ContradictoryDecision(&'static str),
    Data(ProviderDataError),
}

impl Display for CapabilityGatewayError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInvocation(error) => Display::fmt(error, formatter),
            Self::AuthorityMismatch => formatter.write_str("capability authority mismatches spec"),
            Self::ContradictoryDecision(field) => {
                write!(formatter, "capability decision contradicts {field}")
            }
            Self::Data(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for CapabilityGatewayError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidInvocation(error) => Some(error),
            Self::Data(error) => Some(error),
            _ => None,
        }
    }
}
