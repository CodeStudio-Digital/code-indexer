use std::error::Error;
use std::fmt::{self, Debug, Display, Formatter};
use std::io;

use super::WindowsBootstrapCleanup;

#[derive(Debug)]
pub enum WindowsBootstrapIoError {
    Cancelled,
    DeadlineElapsed,
    CleanupPending,
    Io(io::Error),
}

impl Display for WindowsBootstrapIoError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled => formatter.write_str("Windows bootstrap I/O was cancelled"),
            Self::DeadlineElapsed => formatter.write_str("Windows bootstrap I/O deadline elapsed"),
            Self::CleanupPending => {
                formatter.write_str("Windows bootstrap I/O cleanup is still pending")
            }
            Self::Io(source) => write!(formatter, "Windows bootstrap I/O failed: {source}"),
        }
    }
}

impl Error for WindowsBootstrapIoError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(source) => Some(source),
            Self::Cancelled | Self::DeadlineElapsed | Self::CleanupPending => None,
        }
    }
}

/// Start failure returns the untouched channel owner.
pub struct WindowsBootstrapIoStartFailure<O> {
    pub owner: O,
    pub error: WindowsBootstrapIoError,
}

impl<O: Debug> Debug for WindowsBootstrapIoStartFailure<O> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WindowsBootstrapIoStartFailure")
            .field("owner", &self.owner)
            .field("error", &self.error)
            .finish()
    }
}

/// Wait failure distinguishes completed I/O from kernel-owned pending I/O.
#[derive(Debug)]
pub enum WindowsBootstrapIoFailure<O> {
    Clean {
        owner: O,
        error: WindowsBootstrapIoError,
    },
    Owned {
        owner: WindowsBootstrapCleanup,
        error: WindowsBootstrapIoError,
    },
}

impl<O> WindowsBootstrapIoFailure<O> {
    #[must_use]
    pub const fn error(&self) -> &WindowsBootstrapIoError {
        match self {
            Self::Clean { error, .. } | Self::Owned { error, .. } => error,
        }
    }
}

/// Failed cleanup always returns the exact pending owner for reaper retry.
#[derive(Debug)]
pub struct WindowsBootstrapCleanupFailure {
    pub owner: WindowsBootstrapCleanup,
    pub error: WindowsBootstrapIoError,
}
