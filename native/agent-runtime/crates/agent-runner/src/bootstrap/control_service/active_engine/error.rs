use std::fmt::{self, Display, Formatter};

#[derive(Debug)]
pub(super) enum ActiveEngineError {
    Missing(&'static str),
    InvalidLimits,
    InvalidOperation,
    ProviderAuthority,
    CapabilityAuthority,
    TurnFailed,
    CapabilityPrepareFailed,
    CapabilityExecutionFailed,
    CapabilityContextFailed,
    RunBudgetExceeded,
}

impl Display for ActiveEngineError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing(field) => write!(formatter, "active engine is missing {field}"),
            Self::InvalidLimits => formatter.write_str("active engine limits are invalid"),
            Self::InvalidOperation => formatter.write_str("active engine operation is invalid"),
            Self::ProviderAuthority => {
                formatter.write_str("active engine provider authority is invalid")
            }
            Self::CapabilityAuthority => {
                formatter.write_str("active engine capability authority is invalid")
            }
            Self::TurnFailed => formatter.write_str("active engine turn failed closed"),
            Self::CapabilityPrepareFailed => {
                formatter.write_str("active engine capability prepare failed closed")
            }
            Self::CapabilityExecutionFailed => {
                formatter.write_str("active engine capability execution failed closed")
            }
            Self::CapabilityContextFailed => {
                formatter.write_str("active engine capability result context failed closed")
            }
            Self::RunBudgetExceeded => {
                formatter.write_str("active engine turn or tool-call budget was exceeded")
            }
        }
    }
}
