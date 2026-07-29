use std::time::Duration;

use tokio::net::windows::named_pipe::NamedPipeServer;
use tokio::time::{Instant, sleep};

use crate::ipc::{
    EndpointBufferCapacity, ProtectedEndpointAddress, ProtectedEndpointError,
    ProtectedEndpointFailure,
};

use super::sys::{self, PipeProbe};

const PROBE_INTERVAL: Duration = Duration::from_millis(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CleanupState {
    PendingConnect,
    Connected,
}

/// Recoverable cleanup ownership for a Tokio pipe whose overlapped completion
/// may outlive the public handle.
///
/// Availability is proven with a raw first-instance probe; an unproven address
/// remains owned by the reaper.
#[derive(Debug)]
pub struct WindowsEndpointCleanup {
    server: Option<NamedPipeServer>,
    address: ProtectedEndpointAddress,
    capacity: EndpointBufferCapacity,
    state: CleanupState,
}

impl WindowsEndpointCleanup {
    pub(super) const fn new(
        server: NamedPipeServer,
        address: ProtectedEndpointAddress,
        capacity: EndpointBufferCapacity,
        state: CleanupState,
    ) -> Self {
        Self {
            server: Some(server),
            address,
            capacity,
            state,
        }
    }

    /// Cancels/drops the runtime handle and waits until the OS proves that a
    /// fresh first instance can reserve the exact same canonical name.
    ///
    /// # Errors
    ///
    /// Returns ownership to the caller when cleanup cannot be proven before
    /// the deadline or when the operating-system probe fails.
    pub async fn reap(mut self, deadline: Instant) -> Result<(), ProtectedEndpointFailure<Self>> {
        self.begin_cleanup();
        loop {
            match sys::probe_pipe_available(self.address.as_str(), self.capacity) {
                Ok(PipeProbe::Available) => return Ok(()),
                Ok(PipeProbe::Busy) if Instant::now() < deadline => {
                    sleep(PROBE_INTERVAL).await;
                }
                Ok(PipeProbe::Busy) => {
                    return Err(ProtectedEndpointFailure::Owned {
                        owner: self,
                        error: ProtectedEndpointError::DeadlineElapsed,
                    });
                }
                Err(error) => {
                    return Err(ProtectedEndpointFailure::Owned { owner: self, error });
                }
            }
        }
    }

    fn begin_cleanup(&mut self) {
        let Some(server) = self.server.take() else {
            return;
        };
        if self.state == CleanupState::Connected {
            let _ = server.disconnect();
        }
        let _ = sys::cancel_pending_io(&server);
        drop(server);
    }
}
