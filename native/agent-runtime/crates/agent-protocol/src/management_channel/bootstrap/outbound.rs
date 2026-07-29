use std::io::{Read, Write};

use zeroize::Zeroize;

use crate::generated::v1 as wire;
use crate::version::ProtocolVersion;

use super::{BootstrapManagementChannel, policy};
use crate::management_channel::sender::encode_bootstrap;
use crate::management_channel::{ManagementChannelError, ManagementDirection};
use crate::management_secrets::scrub_protected_body;

impl<R: Read, W: Write> BootstrapManagementChannel<R, W> {
    /// Host-side first step: writes `HostSupervisorHello` before any read.
    ///
    /// # Errors
    ///
    /// Wrong direction/order, invalid selection, or write failure poisons.
    pub fn send_host_hello(
        &mut self,
        hello: &wire::HostSupervisorHello,
    ) -> Result<(), ManagementChannelError> {
        let sent_at = self.clock.now_unix_ms();
        self.send_host_hello_at(hello, sent_at)
    }

    #[cfg(test)]
    pub(in crate::management_channel) fn send_host_hello_with_clock<F>(
        &mut self,
        hello: &wire::HostSupervisorHello,
        clock: F,
    ) -> Result<(), ManagementChannelError>
    where
        F: FnOnce() -> i64,
    {
        self.send_host_hello_at(hello, clock())
    }

    fn send_host_hello_at(
        &mut self,
        hello: &wire::HostSupervisorHello,
        sent_at: i64,
    ) -> Result<(), ManagementChannelError> {
        if self.inbound_direction != ManagementDirection::SupervisorToHost
            || self.outbound_sent
            || self.inbound_received
        {
            return self.fail(ManagementChannelError::WrongBootstrapOrder);
        }
        let selection = policy::validate_host_hello(
            hello,
            &self.expected_connection,
            self.expected_management_session_token,
        )
        .inspect_err(|_| {
            self.poison_all();
        })?;
        self.write_hello(
            selection.protocol,
            ManagementDirection::HostToSupervisor,
            wire::management_payload::Body::HostSupervisorHello(hello.clone()),
            sent_at,
        )?;
        self.selection = Some(selection);
        self.outbound_sent = true;
        Ok(())
    }

    /// Supervisor-side second step: writes `SupervisorHello` only after the
    /// host Hello was physically received and validated.
    ///
    /// # Errors
    ///
    /// Wrong order, unsupported selection, or write failure poisons.
    pub fn send_supervisor_hello(
        &mut self,
        hello: &wire::SupervisorHello,
    ) -> Result<(), ManagementChannelError> {
        let sent_at = self.clock.now_unix_ms();
        self.send_supervisor_hello_at(hello, sent_at)
    }

    #[cfg(test)]
    pub(in crate::management_channel) fn send_supervisor_hello_with_clock<F>(
        &mut self,
        hello: &wire::SupervisorHello,
        clock: F,
    ) -> Result<(), ManagementChannelError>
    where
        F: FnOnce() -> i64,
    {
        self.send_supervisor_hello_at(hello, clock())
    }

    fn send_supervisor_hello_at(
        &mut self,
        hello: &wire::SupervisorHello,
        sent_at: i64,
    ) -> Result<(), ManagementChannelError> {
        if self.inbound_direction != ManagementDirection::HostToSupervisor
            || !self.inbound_received
            || self.outbound_sent
        {
            return self.fail(ManagementChannelError::WrongBootstrapOrder);
        }
        let protocol = self
            .selection
            .as_ref()
            .ok_or(ManagementChannelError::WrongBootstrapOrder)?
            .protocol;
        let selection = self
            .selection
            .as_ref()
            .ok_or(ManagementChannelError::WrongBootstrapOrder)?;
        policy::validate_supervisor_hello(hello, selection, self.expected_supervisor_launch_nonce)
            .inspect_err(|_| {
                self.poison_all();
            })?;
        self.write_hello(
            protocol,
            ManagementDirection::SupervisorToHost,
            wire::management_payload::Body::SupervisorHello(hello.clone()),
            sent_at,
        )?;
        self.outbound_sent = true;
        Ok(())
    }

    fn write_hello(
        &mut self,
        protocol: ProtocolVersion,
        direction: ManagementDirection,
        body: wire::management_payload::Body,
        sent_at: i64,
    ) -> Result<(), ManagementChannelError> {
        let mut payload = wire::ManagementPayload { body: Some(body) };
        let encoded = encode_bootstrap(
            protocol,
            &self.expected_connection,
            direction,
            self.channel_id,
            &payload,
            sent_at,
        );
        let mut encoded = match encoded {
            Ok(encoded) => encoded,
            Err(error) => {
                scrub_payload(&mut payload);
                self.poison_all();
                return Err(error);
            }
        };
        let result = self.transport.write_raw(&encoded);
        encoded.as_mut_slice().zeroize();
        scrub_payload(&mut payload);
        result.map_err(|error| {
            self.poison_all();
            ManagementChannelError::Framing(error)
        })
    }
}

fn scrub_payload(payload: &mut wire::ManagementPayload) {
    if let Some(body) = &mut payload.body {
        scrub_protected_body(body);
    }
}
