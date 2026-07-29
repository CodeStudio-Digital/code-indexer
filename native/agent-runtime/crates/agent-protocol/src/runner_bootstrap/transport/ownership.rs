use std::error::Error;
use std::fmt::{self, Debug, Display, Formatter};

use super::RunnerBootstrapTransportError;

/// Failed supervisor handoff send with both physical transport owners retained.
///
/// The returned halves may be cancelled or reaped, but must not be reused as a
/// bootstrap stream because a failed write can leave a partial frame behind.
#[must_use = "failed transport ownership must be cancelled or reaped"]
pub struct RunnerBootstrapSendFailure<R, W> {
    reader: R,
    writer: W,
    error: RunnerBootstrapTransportError,
}

/// Failed supervisor Ready receive with the physical reader owner retained.
#[must_use = "failed transport ownership must be cancelled or reaped"]
pub struct RunnerBootstrapReceiveFailure<R> {
    reader: R,
    error: RunnerBootstrapTransportError,
}

impl<R, W> RunnerBootstrapSendFailure<R, W> {
    pub(super) const fn new(reader: R, writer: W, error: RunnerBootstrapTransportError) -> Self {
        Self {
            reader,
            writer,
            error,
        }
    }

    #[must_use]
    pub const fn error(&self) -> &RunnerBootstrapTransportError {
        &self.error
    }

    #[must_use]
    pub fn into_parts(self) -> (R, W, RunnerBootstrapTransportError) {
        (self.reader, self.writer, self.error)
    }

    #[must_use]
    pub fn into_error(self) -> RunnerBootstrapTransportError {
        self.error
    }
}

impl<R> RunnerBootstrapReceiveFailure<R> {
    pub(super) const fn new(reader: R, error: RunnerBootstrapTransportError) -> Self {
        Self { reader, error }
    }

    #[must_use]
    pub const fn error(&self) -> &RunnerBootstrapTransportError {
        &self.error
    }

    #[must_use]
    pub fn into_parts(self) -> (R, RunnerBootstrapTransportError) {
        (self.reader, self.error)
    }

    #[must_use]
    pub fn into_error(self) -> RunnerBootstrapTransportError {
        self.error
    }
}

impl<R, W> Debug for RunnerBootstrapSendFailure<R, W> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunnerBootstrapSendFailure")
            .field("transport", &"[OWNED; PROTECTED]")
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}

impl<R> Debug for RunnerBootstrapReceiveFailure<R> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunnerBootstrapReceiveFailure")
            .field("transport", &"[OWNED; PROTECTED]")
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}

impl<R, W> Display for RunnerBootstrapSendFailure<R, W> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        Display::fmt(&self.error, formatter)
    }
}

impl<R> Display for RunnerBootstrapReceiveFailure<R> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        Display::fmt(&self.error, formatter)
    }
}

impl<R, W> Error for RunnerBootstrapSendFailure<R, W> {}
impl<R> Error for RunnerBootstrapReceiveFailure<R> {}
