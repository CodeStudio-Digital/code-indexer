use std::error::Error;
use std::fmt::{self, Display, Formatter};

use tokio::sync::mpsc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OnlineLifecycleShutdown {
    terminate_at_unix_ms: i64,
}

impl OnlineLifecycleShutdown {
    /// # Errors
    ///
    /// Shutdown deadlines must be positive owner-clock Unix milliseconds.
    pub const fn new(terminate_at_unix_ms: i64) -> Result<Self, OnlineLifecycleShutdownError> {
        if terminate_at_unix_ms <= 0 {
            return Err(OnlineLifecycleShutdownError::InvalidDeadline);
        }
        Ok(Self {
            terminate_at_unix_ms,
        })
    }

    #[must_use]
    pub const fn terminate_at_unix_ms(self) -> i64 {
        self.terminate_at_unix_ms
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnlineLifecycleShutdownError {
    InvalidDeadline,
    AlreadyPending,
    OwnerClosed,
}

impl Display for OnlineLifecycleShutdownError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid online supervisor shutdown request: {self:?}"
        )
    }
}

impl Error for OnlineLifecycleShutdownError {}

#[derive(Debug, Clone)]
pub struct OnlineLifecycleShutdownHandle {
    sender: mpsc::Sender<OnlineLifecycleShutdown>,
}

impl OnlineLifecycleShutdownHandle {
    pub(super) const fn new(sender: mpsc::Sender<OnlineLifecycleShutdown>) -> Self {
        Self { sender }
    }

    /// Enqueues at most one shutdown transition without waiting or overwriting.
    ///
    /// # Errors
    ///
    /// Fails if a request is already pending or the lifecycle owner has gone.
    pub fn request(
        &self,
        shutdown: OnlineLifecycleShutdown,
    ) -> Result<(), OnlineLifecycleShutdownError> {
        self.sender.try_send(shutdown).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => OnlineLifecycleShutdownError::AlreadyPending,
            mpsc::error::TrySendError::Closed(_) => OnlineLifecycleShutdownError::OwnerClosed,
        })
    }
}
