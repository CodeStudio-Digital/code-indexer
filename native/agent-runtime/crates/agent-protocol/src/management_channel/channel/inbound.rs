use std::io::{Read, Write};

use zeroize::Zeroize;

use super::EstablishedManagementChannel;
use crate::management_channel::channel::validation::validate_management_body;
use crate::management_channel::receiver::ManagementReceiverOutcome;
use crate::management_channel::{ManagementChannelError, ManagementReceiveOutcome};

impl<R: Read, W: Write> EstablishedManagementChannel<R, W> {
    /// Reads exact envelope bytes, samples the private clock afterwards, and
    /// reserves one inbound transaction. Replay resends the original response.
    ///
    /// # Errors
    ///
    /// Any physical or semantic failure permanently poisons the full channel.
    pub fn begin_receive(
        &mut self,
    ) -> Result<Option<ManagementReceiveOutcome>, ManagementChannelError> {
        let mut encoded = self.read_inbound_frame()?;
        let observed_at = self.clock.now_unix_ms();
        let result = self.process_inbound_frame(&encoded, observed_at);
        encoded.as_mut_slice().zeroize();
        result
    }

    #[cfg(test)]
    pub(in crate::management_channel) fn begin_receive_with_clock<F>(
        &mut self,
        clock: F,
    ) -> Result<Option<ManagementReceiveOutcome>, ManagementChannelError>
    where
        F: FnOnce() -> i64,
    {
        let mut encoded = self.read_inbound_frame()?;
        let result = self.process_inbound_frame(&encoded, clock());
        encoded.as_mut_slice().zeroize();
        result
    }

    fn read_inbound_frame(&mut self) -> Result<Vec<u8>, ManagementChannelError> {
        if self.receiver.has_pending() {
            return Err(ManagementChannelError::PendingInboundActive);
        }
        let encoded = self.transport.read_raw().map_err(|error| {
            self.receiver.poison();
            self.sender.poison();
            ManagementChannelError::Framing(error)
        })?;
        let Some(encoded) = encoded else {
            self.poison_all();
            return Err(ManagementChannelError::UnexpectedEof);
        };
        Ok(encoded)
    }

    fn process_inbound_frame(
        &mut self,
        encoded: &[u8],
        observed_at: i64,
    ) -> Result<Option<ManagementReceiveOutcome>, ManagementChannelError> {
        let outcome = self
            .receiver
            .begin_receive(encoded, observed_at)
            .inspect_err(|_| {
                self.transport.poison();
                self.sender.poison();
            })?;
        match outcome {
            ManagementReceiverOutcome::Pending(pending) => {
                let body = pending
                    .body()
                    .ok_or(ManagementChannelError::PendingPayloadConsumed)?;
                let validation = validate_management_body(
                    &self.policy,
                    self.sender.connection(),
                    body,
                    observed_at,
                )
                .and_then(|()| {
                    self.sender.validate_inbound_response(
                        pending.reply_to_message_id(),
                        body,
                        observed_at,
                    )
                });
                if let Err(error) = validation {
                    self.poison_all();
                    return Err(error);
                }
                Ok(Some(ManagementReceiveOutcome::Pending(pending)))
            }
            ManagementReceiverOutcome::Replay { metadata, response } => {
                if let Some(response) = response
                    && let Err(error) = self.transport.write_raw(&response)
                {
                    self.receiver.poison();
                    self.sender.poison();
                    return Err(ManagementChannelError::Framing(error));
                }
                Ok(Some(ManagementReceiveOutcome::Replay(metadata)))
            }
        }
    }
}
