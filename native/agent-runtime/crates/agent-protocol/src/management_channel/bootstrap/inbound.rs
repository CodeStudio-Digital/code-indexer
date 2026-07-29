use std::io::{Read, Write};

use zeroize::Zeroize;

use super::validation::{ReceivedBootstrap, validate_wire_bootstrap};
use super::{BootstrapManagementChannel, ManagementBootstrapHello};
use crate::management_channel::{ManagementChannelError, ManagementDirection};

impl<R: Read, W: Write> BootstrapManagementChannel<R, W> {
    /// Reads the peer Hello and samples the private clock only after the frame.
    ///
    /// # Errors
    ///
    /// EOF, ordering, metadata, deadline, or payload failures poison the owner.
    pub fn receive(&mut self) -> Result<ManagementBootstrapHello, ManagementChannelError> {
        let mut bytes = self.read_bootstrap_frame()?;
        let observed_at = self.clock.now_unix_ms();
        let result = self.validate_received(&bytes, observed_at);
        bytes.as_mut_slice().zeroize();
        result
    }

    #[cfg(test)]
    pub(in crate::management_channel) fn receive_with_clock<F>(
        &mut self,
        clock: F,
    ) -> Result<ManagementBootstrapHello, ManagementChannelError>
    where
        F: FnOnce() -> i64,
    {
        let mut bytes = self.read_bootstrap_frame()?;
        let result = self.validate_received(&bytes, clock());
        bytes.as_mut_slice().zeroize();
        result
    }

    fn read_bootstrap_frame(&mut self) -> Result<Vec<u8>, ManagementChannelError> {
        if self.inbound_received
            || (self.inbound_direction == ManagementDirection::SupervisorToHost
                && !self.outbound_sent)
        {
            return self.fail(ManagementChannelError::WrongBootstrapOrder);
        }
        match self.transport.read_raw() {
            Ok(Some(bytes)) => Ok(bytes),
            Ok(None) => self.fail(ManagementChannelError::UnexpectedEof),
            Err(error) => self.fail(ManagementChannelError::Framing(error)),
        }
    }

    fn validate_received(
        &mut self,
        bytes: &[u8],
        observed_at: i64,
    ) -> Result<ManagementBootstrapHello, ManagementChannelError> {
        let received = validate_wire_bootstrap(
            bytes,
            &self.expected_connection,
            self.inbound_direction,
            self.selection.as_ref(),
            self.expected_supervisor_launch_nonce,
            self.expected_management_session_token,
            observed_at,
        )
        .inspect_err(|_| self.poison_all())?;
        self.install_received(received)
            .inspect_err(|_| self.poison_all())
    }

    fn install_received(
        &mut self,
        received: ReceivedBootstrap,
    ) -> Result<ManagementBootstrapHello, ManagementChannelError> {
        self.inbound_message_id = Some(received.message_id);
        self.inbound_received = true;
        if let Some(selection) = received.selection {
            if self.selection.is_some() {
                return Err(ManagementChannelError::WrongBootstrapOrder);
            }
            self.selection = Some(selection);
        } else if self.selection.is_none() {
            return Err(ManagementChannelError::WrongBootstrapOrder);
        }
        Ok(received.hello)
    }
}
