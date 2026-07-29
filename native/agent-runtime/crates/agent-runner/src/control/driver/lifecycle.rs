use std::io::{Read, Write};

use super::{ControlDriverError, RunnerControlDriver};

impl<R: Read, W: Write> RunnerControlDriver<R, W> {
    /// Rejects the reserved Prepare and permanently closes this driver.
    ///
    /// This is the fail-closed escape hatch when hydration cannot complete or
    /// its token/worker is lost.
    ///
    /// # Errors
    ///
    /// Returns `NoPrepareInFlight` when no Prepare is reserved. A receiver
    /// rejection error is returned after the driver has still been closed.
    pub fn abort_prepare(&mut self) -> Result<(), ControlDriverError> {
        let pending = self
            .pending_prepare
            .take()
            .ok_or(ControlDriverError::NoPrepareInFlight)?
            .inbound;
        let rejected = self
            .channel
            .as_mut()
            .map_or(Err(ControlDriverError::Closed), |channel| {
                channel.reject(pending).map_err(Into::into)
            });
        self.close();
        rejected
    }

    /// Reaps this attempt when its internally observed deadline expires.
    ///
    /// Returns `true` only when this call closed the driver.
    ///
    /// # Errors
    ///
    /// Invalid clock readings fail closed. If hydration is pending, receiver
    /// rejection errors are returned after cleanup has completed.
    pub fn reap_if_expired(&mut self) -> Result<bool, ControlDriverError> {
        if self.is_closed() {
            return Ok(false);
        }
        let observed_at_unix_ms = self.clock.now_unix_ms();
        if observed_at_unix_ms <= 0 {
            return self.close_with(ControlDriverError::InvalidClockReading(observed_at_unix_ms));
        }
        if observed_at_unix_ms < self.session.effective_deadline_at_unix_ms() {
            return Ok(false);
        }
        if self.pending_prepare.is_some() {
            self.abort_prepare()?;
        } else {
            self.close();
        }
        Ok(true)
    }
}
