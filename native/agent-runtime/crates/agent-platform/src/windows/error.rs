use crate::budget::BudgetError;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io;
use std::time::Duration;

#[derive(Debug)]
pub enum WindowsContainmentError {
    Budget(BudgetError),
    InvalidLaunch(&'static str),
    DuplicateEnvironmentVariable,
    CommandLineTooLong {
        units: usize,
        maximum: usize,
    },
    EnvironmentTooLarge {
        units: usize,
        maximum: usize,
    },
    LimitOverflow(&'static str),
    ConfiguredLimitsNotProven,
    MembershipNotProven,
    UnexpectedSuspendCount(u32),
    ReapTimedOut(Duration),
    StartupCleanupFailed {
        original: Box<Self>,
        cleanup: Box<Self>,
    },
    Os {
        operation: &'static str,
        source: io::Error,
    },
}

impl WindowsContainmentError {
    pub(crate) fn last_os_error(operation: &'static str) -> Self {
        Self::Os {
            operation,
            source: io::Error::last_os_error(),
        }
    }
}

impl Display for WindowsContainmentError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Budget(error) => write!(formatter, "{error}"),
            Self::InvalidLaunch(reason) => write!(formatter, "invalid Windows launch: {reason}"),
            Self::DuplicateEnvironmentVariable => {
                formatter.write_str("duplicate case-insensitive environment variable")
            }
            Self::CommandLineTooLong { units, maximum } => {
                write!(
                    formatter,
                    "Windows command line needs {units} UTF-16 units; maximum is {maximum}"
                )
            }
            Self::EnvironmentTooLarge { units, maximum } => {
                write!(
                    formatter,
                    "Windows environment needs {units} UTF-16 units; maximum is {maximum}"
                )
            }
            Self::LimitOverflow(field) => {
                write!(
                    formatter,
                    "resource limit {field} cannot be represented by Windows"
                )
            }
            Self::ConfiguredLimitsNotProven => {
                formatter.write_str("Windows did not report the configured Job Object limits")
            }
            Self::MembershipNotProven => {
                formatter.write_str("Windows did not prove process membership in the Job Object")
            }
            Self::UnexpectedSuspendCount(count) => {
                write!(formatter, "unexpected primary-thread suspend count {count}")
            }
            Self::ReapTimedOut(timeout) => {
                write!(formatter, "resource group was not empty after {timeout:?}")
            }
            Self::StartupCleanupFailed { original, cleanup } => {
                write!(
                    formatter,
                    "post-create validation failed ({original}); explicit cleanup also failed ({cleanup})"
                )
            }
            Self::Os { operation, source } => write!(formatter, "{operation} failed: {source}"),
        }
    }
}

impl Error for WindowsContainmentError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Budget(error) => Some(error),
            Self::StartupCleanupFailed { original, .. } => Some(original.as_ref()),
            Self::Os { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl From<BudgetError> for WindowsContainmentError {
    fn from(value: BudgetError) -> Self {
        Self::Budget(value)
    }
}
